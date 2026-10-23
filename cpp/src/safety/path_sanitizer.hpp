#pragma once
//
// Path sanitizer ported from pixlwiz `media::path` (path_sanitizer.hpp/cpp),
// trimmed for GADM/gridsearch HTTP: relative subpaths under a cache root,
// no URL/VFS schemes. Rejects traversal, null bytes, double-encoding, drives.
//
#include <filesystem>
#include <string>
#include <string_view>

namespace gadm::path {

inline std::string path_to_utf8(const std::filesystem::path& path) {
    const auto utf8 = path.u8string();
    return std::string(reinterpret_cast<const char*>(utf8.data()), utf8.size());
}

inline std::filesystem::path path_from_utf8(std::string_view text) {
#if defined(_MSC_VER)
    // C++20: prefer path ctor over deprecated u8path.
    std::u8string u8(text.begin(), text.end());
    return std::filesystem::path(u8);
#else
    return std::filesystem::u8path(text.begin(), text.end());
#endif
}

inline std::string path_to_generic_utf8(const std::filesystem::path& path) {
    const auto utf8 = path.generic_u8string();
    return std::string(reinterpret_cast<const char*>(utf8.data()), utf8.size());
}

/**
 * Relative VFS-style subpath: no null / traversal / absolute drive / home.
 * Empty input → empty (ok). On violation returns "" and sets `err`.
 */
std::string sanitize_subpath(const std::string& input, std::string& err);

/** Single path segment: rejects separators, controls, `..`, reserved Win names. */
bool is_safe_path_component(std::string_view name);

/**
 * Resolve `relative` under `root`. Returns absolute path only if the result
 * stays inside `root` after lexical normalization. Sets `err` on failure.
 */
std::filesystem::path resolve_under_root(const std::filesystem::path& root,
                                         const std::string& relative,
                                         std::string& err);

/** True when `candidate` is the same as or a descendant of `root`. */
bool is_path_inside_root(const std::filesystem::path& root,
                         const std::filesystem::path& candidate);

} // namespace gadm::path
