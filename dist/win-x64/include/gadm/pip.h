#pragma once

#include <cstddef>
#include <vector>

namespace pip {

/// Ray-casting point-in-polygon test.
/// polygon is a flat array of [x0, y0, x1, y1, ...] coordinates.
/// Returns true if (px, py) is inside the polygon.
inline bool point_in_polygon(
    double px, double py,
    const double* polygon, size_t num_vertices
) {
    bool inside = false;
    for (size_t i = 0, j = num_vertices - 1; i < num_vertices; j = i++) {
        double xi = polygon[i * 2];
        double yi = polygon[i * 2 + 1];
        double xj = polygon[j * 2];
        double yj = polygon[j * 2 + 1];

        if (((yi > py) != (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/// Convenience overload for std::vector<double> ring.
inline bool point_in_polygon(
    double px, double py,
    const std::vector<double>& ring
) {
    return point_in_polygon(px, py, ring.data(), ring.size() / 2);
}

} // namespace pip
