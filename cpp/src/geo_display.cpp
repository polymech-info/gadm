#include "geo_display.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>
#include <vector>

namespace geo_display {
namespace {

constexpr double KM_PER_DEG_LAT = 111.32;
constexpr double PI = 3.14159265358979323846;

using Ring = std::vector<std::pair<double, double>>;

bool is_closed(const Ring &r) {
    return r.size() >= 2 && r.front().first == r.back().first &&
           r.front().second == r.back().second;
}

void close_ring(Ring &r) {
    if (r.empty())
        return;
    if (!is_closed(r))
        r.push_back(r.front());
}

/** One pass: bbox + abs shoelace area + min width (km). Returns false if empty. */
bool ring_metrics(const Ring &pts, double &areaAbs, double &minWidthKm,
                  double &diag) {
    if (pts.size() < 3)
        return false;

    double minx = std::numeric_limits<double>::infinity();
    double miny = std::numeric_limits<double>::infinity();
    double maxx = -std::numeric_limits<double>::infinity();
    double maxy = -std::numeric_limits<double>::infinity();
    double a = 0.0;

    for (size_t i = 0, j = pts.size() - 1; i < pts.size(); j = i++) {
        const double x = pts[i].first;
        const double y = pts[i].second;
        minx = std::min(minx, x);
        maxx = std::max(maxx, x);
        miny = std::min(miny, y);
        maxy = std::max(maxy, y);
        a += pts[j].first * y - x * pts[j].second;
    }

    if (!std::isfinite(minx))
        return false;

    areaAbs = std::abs(a / 2.0);
    const double dx = maxx - minx;
    const double dy = maxy - miny;
    diag = std::hypot(dx, dy);
    if (diag <= 0)
        diag = 1.0;

    const double midLat = (miny + maxy) / 2.0;
    const double cosLat = std::max(0.01, std::cos(midLat * PI / 180.0));
    const double widthKm = dx * KM_PER_DEG_LAT * cosLat;
    const double heightKm = dy * KM_PER_DEG_LAT;
    minWidthKm = std::min(widthKm, heightKm);
    return true;
}

Ring json_to_ring(const nlohmann::json &arr) {
    Ring r;
    if (!arr.is_array())
        return r;
    r.reserve(arr.size());
    for (const auto &pt : arr) {
        if (!pt.is_array() || pt.size() < 2)
            continue;
        r.emplace_back(pt[0].get<double>(), pt[1].get<double>());
    }
    return r;
}

nlohmann::json ring_to_json(const Ring &r) {
    nlohmann::json arr = nlohmann::json::array();
    arr.get_ref<nlohmann::json::array_t &>().reserve(r.size());
    for (const auto &c : r) {
        arr.push_back(nlohmann::json::array({c.first, c.second}));
    }
    return arr;
}

void smooth_coast_ring_inplace(Ring &ring, const Options &opts) {
    if (ring.size() < 4)
        return;
    if (is_closed(ring))
        ring.pop_back();
    if (ring.size() < 3) {
        close_ring(ring);
        return;
    }

    double areaAbs = 0, minWidthKm = 0, diag = 1.0;
    if (!ring_metrics(ring, areaAbs, minWidthKm, diag)) {
        close_ring(ring);
        return;
    }

    const double maxLeg = std::max(diag * opts.maxLegFrac, opts.minLegDeg);
    const double maxLeg2 = maxLeg * maxLeg;
    const double maxEarArea = diag * diag * opts.maxEarAreaFrac;
    const double cosTip = std::cos(opts.maxTipDeg * PI / 180.0);

    // Reused across passes — sized to initial n (never grows).
    std::vector<char> keep;
    keep.reserve(ring.size());

    for (int pass = 0; pass < opts.maxPasses; ++pass) {
        const size_t n = ring.size();
        if (n < 4)
            break;

        keep.assign(n, 1);
        int passRemoved = 0;

        for (size_t i = 0; i < n; ++i) {
            const size_t i0 = i == 0 ? n - 1 : i - 1;
            const size_t i2 = i + 1 == n ? 0 : i + 1;
            if (!keep[i0] || !keep[i2])
                continue;

            const auto &a = ring[i0];
            const auto &b = ring[i];
            const auto &c = ring[i2];

            // Vectors from tip B toward A and C (matches prior unit-vector setup).
            const double ux = a.first - b.first;
            const double uy = a.second - b.second;
            const double vx = c.first - b.first;
            const double vy = c.second - b.second;

            const double ab2 = ux * ux + uy * uy;
            const double bc2 = vx * vx + vy * vy;

            if (ab2 < 1e-30 || bc2 < 1e-30) {
                keep[i] = 0;
                ++passRemoved;
                continue;
            }

            // Long legs: not a local spike/ear — skip expensive work.
            if (ab2 > maxLeg2 || bc2 > maxLeg2)
                continue;

            const double cosv =
                std::clamp((ux * vx + uy * vy) / std::sqrt(ab2 * bc2), -1.0, 1.0);

            const bool angleOkForSpike = cosv >= cosTip;
            const bool angleOkForEar = cosv > -0.15;
            if (!angleOkForSpike && !angleOkForEar)
                continue;

            // Area only when still an ear candidate.
            double triArea = 0.0;
            if (angleOkForEar) {
                triArea = 0.5 * std::abs(ux * vy - uy * vx);
                if (triArea > maxEarArea && !angleOkForSpike)
                    continue;
            }

            // Detour only for remaining candidates.
            const double wx = c.first - a.first;
            const double wy = c.second - a.second;
            const double ac2 = wx * wx + wy * wy;
            const double ab = std::sqrt(ab2);
            const double bc = std::sqrt(bc2);
            const double detour =
                ac2 > 1e-30 ? (ab + bc) / std::sqrt(ac2)
                            : std::numeric_limits<double>::infinity();

            const bool isSpike =
                angleOkForSpike && detour >= opts.minDetour;
            const bool isEar =
                angleOkForEar && triArea <= maxEarArea && detour >= 1.05;

            if (isSpike || isEar) {
                keep[i] = 0;
                ++passRemoved;
            }
        }

        if (!passRemoved)
            break;

        size_t survivors = 0;
        for (size_t i = 0; i < n; ++i)
            if (keep[i])
                ++survivors;
        if (survivors < 3)
            break;

        // Compact in place.
        size_t dst = 0;
        for (size_t src = 0; src < n; ++src) {
            if (keep[src])
                ring[dst++] = ring[src];
        }
        ring.resize(dst);
    }

    close_ring(ring);
}

bool clean_polygon_coords(nlohmann::json &coords, const Options &opts) {
    if (!coords.is_array() || coords.empty())
        return false;

    // Strip holes unless keepHoles — keep exterior by move.
    if (!opts.keepHoles && coords.size() > 1) {
        nlohmann::json exterior = std::move(coords[0]);
        coords = nlohmann::json::array();
        coords.push_back(std::move(exterior));
    }

    if (!opts.skipCoastSmooth) {
        for (auto &ringJ : coords) {
            Ring r = json_to_ring(ringJ);
            smooth_coast_ring_inplace(r, opts);
            if (r.size() < 4)
                return false;
            ringJ = ring_to_json(r);
        }
    } else {
        // Cheap validity: need ≥4 positions on exterior (incl. close).
        if (!coords[0].is_array() || coords[0].size() < 4)
            return false;
    }
    return true;
}

/**
 * Drop MultiPolygon parts under minOuterWidthKm.
 * Largest part (by area) always kept; others kept by width. No sort —
 * output order matches original ring order.
 */
bool drop_small_parts(nlohmann::json &geometry, const Options &opts) {
    if (!(opts.minOuterWidthKm > 0))
        return true;
    if (!geometry.is_object() || !geometry.contains("type"))
        return true;
    if (geometry["type"].get<std::string>() != "MultiPolygon")
        return true;

    auto &coords = geometry["coordinates"];
    if (!coords.is_array() || coords.empty())
        return false;

    const size_t n = coords.size();
    std::vector<double> area(n, 0.0);
    std::vector<double> widthKm(n, 0.0);
    std::vector<char> valid(n, 0);

    size_t largest = 0;
    double largestArea = -1.0;
    size_t validCount = 0;

    for (size_t i = 0; i < n; ++i) {
        auto &poly = coords[i];
        if (!poly.is_array() || poly.empty())
            continue;
        Ring exterior = json_to_ring(poly[0]);
        if (exterior.size() < 4)
            continue;

        double a = 0, w = 0, d = 1;
        if (!ring_metrics(exterior, a, w, d))
            continue;

        area[i] = a;
        widthKm[i] = w;
        valid[i] = 1;
        ++validCount;
        if (a > largestArea) {
            largestArea = a;
            largest = i;
        }
    }

    if (validCount == 0)
        return false;

    nlohmann::json kept = nlohmann::json::array();
    for (size_t i = 0; i < n; ++i) {
        if (!valid[i])
            continue;
        if (i == largest || widthKm[i] >= opts.minOuterWidthKm) {
            kept.push_back(std::move(coords[i]));
        }
    }

    if (kept.empty())
        return false;
    if (kept.size() == 1) {
        geometry["type"] = "Polygon";
        geometry["coordinates"] = std::move(kept[0]);
    } else {
        geometry["coordinates"] = std::move(kept);
    }
    return true;
}

bool clean_geometry_impl(nlohmann::json &geometry, const Options &opts);

bool clean_geometry_impl(nlohmann::json &geometry, const Options &opts) {
    if (!geometry.is_object() || !geometry.contains("type"))
        return false;
    const std::string type = geometry["type"].get<std::string>();

    if (type == "Polygon") {
        if (!geometry.contains("coordinates"))
            return false;
        if (!opts.keepHoles) {
            auto &coords = geometry["coordinates"];
            if (coords.is_array() && coords.size() > 1) {
                nlohmann::json exterior = std::move(coords[0]);
                coords = nlohmann::json::array();
                coords.push_back(std::move(exterior));
            }
        }
        return clean_polygon_coords(geometry["coordinates"], opts);
    }

    if (type == "MultiPolygon") {
        if (!geometry.contains("coordinates") || !geometry["coordinates"].is_array())
            return false;

        if (!opts.keepHoles) {
            for (auto &poly : geometry["coordinates"]) {
                if (poly.is_array() && poly.size() > 1) {
                    nlohmann::json exterior = std::move(poly[0]);
                    poly = nlohmann::json::array();
                    poly.push_back(std::move(exterior));
                }
            }
        }

        if (!drop_small_parts(geometry, opts))
            return false;

        if (geometry["type"] == "Polygon")
            return clean_polygon_coords(geometry["coordinates"], opts);

        nlohmann::json nextParts = nlohmann::json::array();
        for (auto &poly : geometry["coordinates"]) {
            if (!clean_polygon_coords(poly, opts))
                continue;
            nextParts.push_back(std::move(poly));
        }
        if (nextParts.empty())
            return false;
        if (nextParts.size() == 1) {
            geometry["type"] = "Polygon";
            geometry["coordinates"] = std::move(nextParts[0]);
        } else {
            geometry["coordinates"] = std::move(nextParts);
        }
        return true;
    }

    if (type == "GeometryCollection") {
        if (!geometry.contains("geometries") || !geometry["geometries"].is_array())
            return false;
        nlohmann::json kept = nlohmann::json::array();
        for (auto &g : geometry["geometries"]) {
            if (clean_geometry_impl(g, opts))
                kept.push_back(std::move(g));
        }
        if (kept.empty())
            return false;
        if (kept.size() == 1) {
            geometry = std::move(kept[0]);
        } else {
            geometry["geometries"] = std::move(kept);
        }
        return true;
    }

    return true;
}

} // namespace

bool clean_geometry(nlohmann::json &geometry, const Options &opts) {
    return clean_geometry_impl(geometry, opts);
}

void clean_feature_collection(nlohmann::json &fc, const Options &opts) {
    if (!fc.is_object())
        return;
    if (!fc.contains("features") || !fc["features"].is_array())
        return;

    nlohmann::json kept = nlohmann::json::array();
    for (auto &f : fc["features"]) {
        if (!f.is_object() || !f.contains("geometry"))
            continue;
        if (!clean_geometry(f["geometry"], opts))
            continue;
        kept.push_back(std::move(f));
    }
    fc["features"] = std::move(kept);
    fc["_mapPaint"] = true;
}

} // namespace geo_display
