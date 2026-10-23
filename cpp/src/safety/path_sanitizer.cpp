#include "safety/path_sanitizer.hpp"

#include <algorithm>
#include <cctype>
#include <regex>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace gadm::path {
namespace {

void trim_in_place(std::string& s) {
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front())))
        s.erase(0, 1);
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())))
        s.pop_back();
}

void decode_percent_escapes(std::string& s) {
    // Decode %2e / %2f / %5c up to 4 passes (traversal probes).
    for (int p = 0; p < 4; ++p) {
        for (size_t i = 0; i + 2 < s.size(); ++i) {
            if (s[i] != '%') continue;
            const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(s[i + 1])));
            const char b2 = static_cast<char>(std::tolower(static_cast<unsigned char>(s[i + 2])));
            char repl = 0;
            if (a == '2' && b2 == 'e')
                repl = '.';
            else if (a == '2' && b2 == 'f')
                repl = '/';
            else if (a == '5' && b2 == 'c')
                repl = '\\';
            if (repl) {
                s.replace(i, 3, 1, repl);
            }
        }
    }
}

void slash_unify(std::string& s) {
    for (char& c : s) {
        if (c == '\\') c = '/';
    }
}

bool has_double_percent_encoding(const std::string& s) {
    for (size_t i = 0; i + 2 < s.size(); ++i) {
        if (s[i] != '%') continue;
        if (std::tolower(static_cast<unsigned char>(s[i + 1])) == '2' &&
            std::tolower(static_cast<unsigned char>(s[i + 2])) == '5')
            return true;
    }
    return false;
}

bool home_escape(const std::string& s) {
    return s == "~" || (s.size() >= 2 && s[0] == '~' && s[1] == '/');
}

bool subpath_traversal_violation(const std::string& normalized, std::string& err) {
    err.clear();
    const std::string probe = normalized + "/";
    static const std::regex mid(R"(([/\\])\.\.([/\\]))");
    if (std::regex_search(probe, mid)) {
        err = "EFORBIDDEN: path traversal";
        return true;
    }
    if (normalized.rfind("../", 0) == 0 || normalized == ".." ||
        (normalized.size() >= 3 && normalized.substr(normalized.size() - 3) == "/..")) {
        err = "EFORBIDDEN: path traversal";
        return true;
    }
    const std::string t = "/" + normalized + "/";
    if (t.find("/../") != std::string::npos) {
        err = "EFORBIDDEN: path traversal";
        return true;
    }
    return false;
}

} // namespace

std::string sanitize_subpath(const std::string& input, std::string& err) {
    err.clear();
    std::string t = input;
    trim_in_place(t);
    if (t.empty()) return {};

    if (t.find('\0') != std::string::npos) {
        err = "EFORBIDDEN: null byte in path";
        return {};
    }
    if (has_double_percent_encoding(t)) {
        err = "EFORBIDDEN: double-encoded path segment";
        return {};
    }
    if (home_escape(t)) {
        err = "EFORBIDDEN: home directory access denied";
        return {};
    }

    decode_percent_escapes(t);
    slash_unify(t);
    if (subpath_traversal_violation(t, err)) return {};

    while (!t.empty() && t[0] == '/') t.erase(0, 1);
    if (t.size() >= 2) {
        const char c0 = static_cast<char>(std::tolower(static_cast<unsigned char>(t[0])));
        if (c0 >= 'a' && c0 <= 'z' && t[1] == ':') {
            err = "EFORBIDDEN: absolute path";
            return {};
        }
    }

    // Collapse duplicate slashes
    for (size_t i = 0; i < t.size();) {
        if (t[i] == '/') {
            size_t j = i + 1;
            while (j < t.size() && t[j] == '/') ++j;
            if (j > i + 1)
                t.erase(i + 1, j - (i + 1));
            else
                ++i;
        } else
            ++i;
    }

    try {
        const fs::path n = path_from_utf8(t).lexically_normal();
        t = path_to_generic_utf8(n);
    } catch (...) {
        err = "EFORBIDDEN: invalid path encoding";
        return {};
    }
    slash_unify(t);
    while (!t.empty() && t[0] == '/') t.erase(0, 1);
    while (!t.empty() && t.back() == '/') t.pop_back();
    if (t == ".") t.clear();

    size_t a = 0;
    for (size_t i = 0; i <= t.size(); ++i) {
        if (i == t.size() || t[i] == '/') {
            if (a < i) {
                const std::string seg = t.substr(a, i - a);
                if (seg == ".." || seg == ".") {
                    err = "EFORBIDDEN: path traversal survived normalization";
                    return {};
                }
            }
            a = i + 1;
        }
    }
    return t;
}

bool is_safe_path_component(std::string_view name) {
    if (name.empty() || name == "." || name == "..") return false;
    if (name.find('\0') != std::string_view::npos) return false;
    if (name.size() > 255) return false;

    static const std::regex k_illegal(R"([/?<>\\:*|"])");
    static const std::regex k_ctrl(R"([\x00-\x1f\x80-\x9f])");
    static const std::regex k_winres(R"(^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$)",
                                     std::regex::icase);

    const std::string s(name);
    if (std::regex_search(s, k_illegal)) return false;
    if (std::regex_search(s, k_ctrl)) return false;
    if (std::regex_match(s, k_winres)) return false;
    return true;
}

bool is_path_inside_root(const fs::path& root, const fs::path& candidate) {
    std::error_code ec;
    const fs::path root_abs = fs::weakly_canonical(root, ec);
    if (ec) return false;
    const fs::path cand_abs = fs::weakly_canonical(candidate, ec);
    if (ec) {
        // File may not exist yet — fall back to lexical relative check.
        const fs::path rel = candidate.lexically_normal().lexically_relative(root.lexically_normal());
        const auto s = rel.generic_string();
        return !s.empty() && s != ".." && s.rfind("../", 0) != 0;
    }
    const fs::path rel = cand_abs.lexically_relative(root_abs);
    const auto s = rel.generic_string();
    return !s.empty() && s != ".." && s.rfind("../", 0) != 0;
}

fs::path resolve_under_root(const fs::path& root, const std::string& relative, std::string& err) {
    err.clear();
    std::string clean = sanitize_subpath(relative, err);
    if (!err.empty()) return {};
    if (clean.empty()) {
        err = "EFORBIDDEN: empty path";
        return {};
    }

    // Each segment must be a safe component (blocks Windows device names etc.).
    {
        size_t a = 0;
        for (size_t i = 0; i <= clean.size(); ++i) {
            if (i == clean.size() || clean[i] == '/') {
                if (a < i) {
                    if (!is_safe_path_component(clean.substr(a, i - a))) {
                        err = "EFORBIDDEN: unsafe path component";
                        return {};
                    }
                }
                a = i + 1;
            }
        }
    }

    const fs::path joined = (root / path_from_utf8(clean)).lexically_normal();
    if (!is_path_inside_root(root, joined)) {
        err = "EFORBIDDEN: path escapes cache root";
        return {};
    }
    return joined;
}

} // namespace gadm::path
