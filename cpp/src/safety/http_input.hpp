#pragma once
//
// Domain validators for proxied GADM / gridsearch HTTP inputs.
//
#include <cstddef>
#include <string>
#include <string_view>

namespace gadm::http_input {

inline constexpr size_t kMaxGidBytes = 64;
inline constexpr size_t kMaxQueryBytes = 256;
inline constexpr size_t kMaxCountryBytes = 8;
inline constexpr size_t kMaxCacheRelPathBytes = 512;

/** UUID-ish (hex + hyphens), length 32–40 — same contract as gridsearch-http. */
[[nodiscard]] bool is_uuid_ish(std::string_view s) noexcept;

/**
 * GADM GID: ISO-3166-1 alpha-3 root + optional `.seg` segments.
 * Segments: letters, digits, `_`, `-` only. No `/`, `\`, `..`, `%`, null.
 * Examples: `ESP`, `ESP.6_1`, `FRA.11.1_1`.
 */
[[nodiscard]] bool is_gadm_gid(std::string_view s) noexcept;

/** ISO country filter for search (`ESP`, `FR`, empty ok via caller). */
[[nodiscard]] bool is_country_code(std::string_view s) noexcept;

/** Search / names query text: printable-ish, bounded, no null/controls. */
[[nodiscard]] bool is_safe_search_query(std::string_view s) noexcept;

} // namespace gadm::http_input
