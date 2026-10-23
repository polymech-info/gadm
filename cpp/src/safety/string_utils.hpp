#pragma once
//
// Lightweight string helpers ported from pixlwiz `string_utils.hpp`
// (ASCII-only; no fuzzy/NLP stack — HTTP / path safety only).
//
#include <cctype>
#include <cstddef>
#include <string>
#include <string_view>

namespace gadm::strutil {

[[nodiscard]] inline bool starts_with_ascii_ci(std::string_view text,
                                               std::string_view prefix) noexcept {
    if (text.size() < prefix.size()) return false;
    for (size_t i = 0; i < prefix.size(); ++i) {
        const auto a = static_cast<unsigned char>(text[i]);
        const auto b = static_cast<unsigned char>(prefix[i]);
        const auto al = (a >= 'A' && a <= 'Z') ? static_cast<unsigned char>(a - 'A' + 'a') : a;
        const auto bl = (b >= 'A' && b <= 'Z') ? static_cast<unsigned char>(b - 'A' + 'a') : b;
        if (al != bl) return false;
    }
    return true;
}

[[nodiscard]] inline std::string lower_ascii(std::string s) {
    for (char& c : s) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return s;
}

[[nodiscard]] inline std::string trim(std::string s) {
    while (!s.empty() &&
           std::isspace(static_cast<unsigned char>(s.front())))
        s.erase(0, 1);
    while (!s.empty() &&
           std::isspace(static_cast<unsigned char>(s.back())))
        s.pop_back();
    return s;
}

[[nodiscard]] inline bool contains_null(std::string_view s) noexcept {
    return s.find('\0') != std::string_view::npos;
}

/** True if `s` has ASCII control bytes (incl. CR/LF/TAB) or DEL. */
[[nodiscard]] inline bool contains_ascii_controls(std::string_view s) noexcept {
    for (unsigned char c : s) {
        if (c < 0x20 || c == 0x7F) return true;
    }
    return false;
}

/** Cap query/path strings so proxy clients cannot blow memory / OGR. */
[[nodiscard]] inline bool within_length(std::string_view s, size_t max_bytes) noexcept {
    return s.size() <= max_bytes;
}

} // namespace gadm::strutil
