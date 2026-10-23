#include "names_search.h"
#include "gpkg_reader.h"

#include <algorithm>
#include <cctype>
#include <sstream>

namespace gadm_names {

using json = nlohmann::json;

namespace {

std::string sql_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 4);
    for (char c : s) {
        if (c == '\'') out += "''";
        else out += c;
    }
    return out;
}

int infer_gid_level(const std::string& admin) {
    if (admin.find('.') == std::string::npos) return 0;
    return static_cast<int>(std::count(admin.begin(), admin.end(), '.'));
}

} // namespace

json search_regions(
    const std::string& gpkg_path,
    const std::string& query,
    int content_level,
    const std::string& country,
    int limit
) {
    if (query.empty()) {
        return json{{"data", json::array()}};
    }
    if (limit <= 0) limit = 50;

    const std::string q = sql_escape(query);
    const std::string country_esc = sql_escape(country);

    json data = json::array();
    auto append_rows = [&](const std::vector<std::map<std::string, std::string>>& rows) {
        for (const auto& row : rows) {
            json j = json::object();
            for (const auto& kv : row) j[kv.first] = kv.second;
            data.push_back(std::move(j));
        }
    };
    auto try_filter = [&](int level, const std::string& filt) {
        if (static_cast<int>(data.size()) >= limit) return;
        append_rows(gpkg_reader::query_names(
            gpkg_path, level, filt, limit - static_cast<int>(data.size())));
    };
    auto country_clause = [&]() -> std::string {
        if (country.empty()) return {};
        return " AND GID_0 = '" + country_esc + "'";
    };

    auto levels = [&]() -> std::vector<int> {
        if (content_level >= 0 && content_level <= 5) return {content_level};
        return {0, 1, 2, 3, 4, 5};
    }();

    // Exact (=) → prefix → substring. Stop as soon as we have rows in auto mode.
    for (int level : levels) {
        try_filter(level, "NAME_" + std::to_string(level) + " = '" + q + "'" + country_clause());
        if (!data.empty() && content_level < 0) break;
    }
    if (data.empty()) {
        for (int level : levels) {
            try_filter(level, "NAME_" + std::to_string(level) + " LIKE '" + q + "%'" + country_clause());
            if (!data.empty() && content_level < 0) break;
        }
    }
    if (data.empty()) {
        // Substring only on coarser levels — leading-wildcard can't use the name index.
        for (int level : levels) {
            if (level > 2 && content_level < 0) continue;
            try_filter(level,
                       "NAME_" + std::to_string(level) + " LIKE '%" + q + "%'" + country_clause());
            if (!data.empty() && content_level < 0) break;
        }
    }

    // GID-style query fallback
    if (data.empty()) {
        int start = content_level >= 0 ? content_level : 0;
        int end = content_level >= 0 ? content_level : 5;
        for (int level = start; level <= end; ++level) {
            std::ostringstream filt;
            filt << "GID_" << level << " LIKE '" << q << "%'";
            if (!country.empty()) filt << " AND GID_0 = '" << country_esc << "'";
            auto rows = gpkg_reader::query_names(
                gpkg_path, level, filt.str(), limit - static_cast<int>(data.size()));
            for (const auto& row : rows) {
                json j = json::object();
                for (const auto& kv : row) j[kv.first] = kv.second;
                data.push_back(std::move(j));
            }
            if (static_cast<int>(data.size()) >= limit) break;
        }
    }

    return json{{"data", std::move(data)}};
}

json region_names(
    const std::string& gpkg_path,
    const std::string& admin,
    int content_level,
    int depth
) {
    if (admin.empty()) {
        return json{{"error", "admin is required"}};
    }
    if (depth <= 0) depth = 1;
    if (depth > 5) depth = 5;

    const int admin_level = infer_gid_level(admin);
    int start_level = content_level >= 0 ? content_level : (admin_level + 1);
    if (start_level < 0) start_level = 0;
    if (start_level > 5) start_level = 5;

    const std::string admin_esc = sql_escape(admin);
    json data = json::array();

    for (int i = 0; i < depth; ++i) {
        int level = start_level + i;
        if (level > 5) break;
        std::ostringstream filt;
        filt << "GID_" << admin_level << " = '" << admin_esc << "'";
        auto rows = gpkg_reader::query_names(gpkg_path, level, filt.str(), 5000);
        if (rows.empty()) break;
        for (const auto& row : rows) {
            json j = json::object();
            for (const auto& kv : row) j[kv.first] = kv.second;
            data.push_back(std::move(j));
        }
    }

    return json{{"data", std::move(data)}};
}

} // namespace gadm_names
