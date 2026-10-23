#include <catch2/catch_test_macros.hpp>

#include "safety/http_input.hpp"
#include "safety/path_sanitizer.hpp"
#include "safety/string_utils.hpp"

#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

TEST_CASE("strutil trim / controls", "[safety][strutil]") {
    REQUIRE(gadm::strutil::trim("  ab  ") == "ab");
    REQUIRE(gadm::strutil::contains_null(std::string("a\0b", 3)));
    REQUIRE(gadm::strutil::contains_ascii_controls("a\nb"));
    REQUIRE_FALSE(gadm::strutil::contains_ascii_controls("ok"));
}

TEST_CASE("is_gadm_gid accepts normal GIDs", "[safety][gid]") {
    REQUIRE(gadm::http_input::is_gadm_gid("ESP"));
    REQUIRE(gadm::http_input::is_gadm_gid("ESP.6_1"));
    REQUIRE(gadm::http_input::is_gadm_gid("FRA.11.1_1"));
    REQUIRE(gadm::http_input::is_gadm_gid("DEU"));
}

TEST_CASE("is_gadm_gid rejects traversal / injection", "[safety][gid][security]") {
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid(""));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("../ESP"));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("ESP/../etc"));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("ESP\\..\\x"));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("ESP%2e%2e"));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("ESP..BAD"));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("ESP."));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid(std::string("ESP\0X", 5)));
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("E")); // too short
    REQUIRE_FALSE(gadm::http_input::is_gadm_gid("TOOLONGCODE"));
}

TEST_CASE("is_uuid_ish", "[safety][uuid]") {
    REQUIRE(gadm::http_input::is_uuid_ish("e0a0b1c2-d3e4-5678-9abc-def012345678"));
    REQUIRE_FALSE(gadm::http_input::is_uuid_ish("not-a-uuid"));
    REQUIRE_FALSE(gadm::http_input::is_uuid_ish("'; DROP TABLE"));
    REQUIRE_FALSE(gadm::http_input::is_uuid_ish(""));
}

TEST_CASE("sanitize_subpath blocks traversal", "[safety][path][security]") {
    std::string err;
    REQUIRE(gadm::path::sanitize_subpath("ESP/boundary.json", err) == "ESP/boundary.json");
    REQUIRE(err.empty());

    REQUIRE(gadm::path::sanitize_subpath("../etc/passwd", err).empty());
    REQUIRE(err.find("traversal") != std::string::npos);

    REQUIRE(gadm::path::sanitize_subpath("foo/../../etc", err).empty());
    REQUIRE(gadm::path::sanitize_subpath("C:/Windows", err).empty());
    REQUIRE(err.find("absolute") != std::string::npos);

    REQUIRE(gadm::path::sanitize_subpath("%2e%2e/%2e%2e/etc", err).empty());
    REQUIRE(gadm::path::sanitize_subpath("foo/%252e%252e/bar", err).empty()); // double-encoded
    REQUIRE(gadm::path::sanitize_subpath(std::string("a\0b", 3), err).empty());
    REQUIRE(gadm::path::sanitize_subpath("~/.ssh/id_rsa", err).empty());
}

TEST_CASE("resolve_under_root stays inside cache", "[safety][path][security]") {
    const fs::path root = fs::temp_directory_path() / "gadm_safety_test_root";
    fs::create_directories(root / "ESP");
    {
        std::ofstream out(root / "ESP" / "boundary_ESP_0.json");
        out << "{}";
    }

    std::string err;
    auto ok = gadm::path::resolve_under_root(root, "ESP/boundary_ESP_0.json", err);
    REQUIRE(err.empty());
    REQUIRE(fs::exists(ok));
    REQUIRE(gadm::path::is_path_inside_root(root, ok));

    auto bad = gadm::path::resolve_under_root(root, "../ESP/boundary_ESP_0.json", err);
    REQUIRE(bad.empty());
    REQUIRE_FALSE(err.empty());

    auto abs_escape = gadm::path::resolve_under_root(root, "ESP/../../outside.json", err);
    REQUIRE(abs_escape.empty());

    fs::remove_all(root);
}

TEST_CASE("is_safe_path_component", "[safety][path]") {
    REQUIRE(gadm::path::is_safe_path_component("ESP"));
    REQUIRE(gadm::path::is_safe_path_component("boundary_ESP_0.json"));
    REQUIRE_FALSE(gadm::path::is_safe_path_component(".."));
    REQUIRE_FALSE(gadm::path::is_safe_path_component("a/b"));
    REQUIRE_FALSE(gadm::path::is_safe_path_component("CON"));
    REQUIRE_FALSE(gadm::path::is_safe_path_component(""));
}

TEST_CASE("search query / country validators", "[safety][http]") {
    REQUIRE(gadm::http_input::is_safe_search_query("Barcelona"));
    REQUIRE_FALSE(gadm::http_input::is_safe_search_query("../etc"));
    REQUIRE_FALSE(gadm::http_input::is_safe_search_query("a%2f"));
    REQUIRE(gadm::http_input::is_country_code("ESP"));
    REQUIRE(gadm::http_input::is_country_code(""));
    REQUIRE_FALSE(gadm::http_input::is_country_code("ES1"));
}
