#pragma once

#include <vector>
#include "types.h"

namespace geo_merge {

/// Merge multiple features that share the same GID code by unioning their geometries.
/// Uses GEOS GEOSUnaryUnion with GEOSMakeValid fallback.
std::vector<boundary::BoundaryFeature> merge(
    const std::vector<boundary::BoundaryFeature>& features
);

} // namespace geo_merge
