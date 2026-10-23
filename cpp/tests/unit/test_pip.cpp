#include <catch2/catch_test_macros.hpp>
#include "pip.h"

TEST_CASE("Point inside simple square", "[pip]") {
    // Square: (0,0) → (10,0) → (10,10) → (0,10)
    double ring[] = {0, 0, 10, 0, 10, 10, 0, 10};
    REQUIRE(pip::point_in_polygon(5.0, 5.0, ring, 4));
}

TEST_CASE("Point outside simple square", "[pip]") {
    double ring[] = {0, 0, 10, 0, 10, 10, 0, 10};
    REQUIRE_FALSE(pip::point_in_polygon(15.0, 5.0, ring, 4));
}

TEST_CASE("Point on edge is implementation-defined", "[pip]") {
    double ring[] = {0, 0, 10, 0, 10, 10, 0, 10};
    // Edge cases are allowed to return either true or false
    // Just verify it doesn't crash
    (void)pip::point_in_polygon(0.0, 5.0, ring, 4);
}

TEST_CASE("Point inside triangle", "[pip]") {
    double ring[] = {0, 0, 20, 0, 10, 15};
    REQUIRE(pip::point_in_polygon(10.0, 5.0, ring, 3));
    REQUIRE_FALSE(pip::point_in_polygon(0.0, 15.0, ring, 3));
}
