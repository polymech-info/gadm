#include "safety/http_input.hpp"

#include "safety/string_utils.hpp"

#include <cctype>

namespace gadm::http_input {

bool is_uuid_ish(std::string_view s) noexcept {
    if (s.size() < 32 || s.size() > 40) return false;
    if (strutil::contains_null(s) || strutil::contains_ascii_controls(s)) return false;
    for (unsigned char c : s) {
        if (!(std::isxdigit(c) || c == '-')) return false;
    }
    return true;
}

bool is_gadm_gid(std::string_view s) noexcept {
    if (s.empty() || s.size() > kMaxGidBytes) return false;
    if (strutil::contains_null(s) || strutil::contains_ascii_controls(s)) return false;
    // No path / encoding tricks inside a GID used for filesystem joins.
    for (unsigned char c : s) {
        if (c == '/' || c == '\\' || c == '%' || c == '\0') return false;
    }
    if (s.find("..") != std::string_view::npos) return false;

    // First segment: 3-letter country (or rarely longer codes we still allow A–Z).
    size_t i = 0;
    size_t letters = 0;
    while (i < s.size() && s[i] != '.') {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) return false;
        ++letters;
        ++i;
    }
    if (letters < 2 || letters > 4) return false; // ISO2/3 (+ rare)

    while (i < s.size()) {
        if (s[i] != '.') return false;
        ++i;
        if (i >= s.size()) return false; // trailing dot
        size_t seg = 0;
        while (i < s.size() && s[i] != '.') {
            const unsigned char c = static_cast<unsigned char>(s[i]);
            const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                            (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (!ok) return false;
            ++seg;
            ++i;
        }
        if (seg == 0 || seg > 24) return false;
    }
    return true;
}

bool is_country_code(std::string_view s) noexcept {
    if (s.empty()) return true;
    if (s.size() > kMaxCountryBytes) return false;
    if (strutil::contains_null(s) || strutil::contains_ascii_controls(s)) return false;
    for (unsigned char c : s) {
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) return false;
    }
    return s.size() >= 2 && s.size() <= 3;
}

bool is_safe_search_query(std::string_view s) noexcept {
    if (s.empty() || s.size() > kMaxQueryBytes) return false;
    if (strutil::contains_null(s) || strutil::contains_ascii_controls(s)) return false;
    // Reject path-shaped injection into OGR SQL builders.
    if (s.find("../") != std::string_view::npos || s.find("..\\") != std::string_view::npos)
        return false;
    if (s.find('%') != std::string_view::npos) return false;
    return true;
}

} // namespace gadm::http_input
