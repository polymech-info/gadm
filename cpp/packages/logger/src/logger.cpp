#include "logger/logger.h"

#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/spdlog.h>


namespace logger {

void init(const std::string &app_name) {
  auto console = spdlog::stdout_color_mt(app_name);
  spdlog::set_default_logger(console);
  spdlog::set_level(spdlog::level::debug);
  spdlog::set_pattern("[%H:%M:%S] [%^%l%$] %v");
}

void info(const std::string &msg) { spdlog::info(msg); }
void warn(const std::string &msg) { spdlog::warn(msg); }
void error(const std::string &msg) { spdlog::error(msg); }
void debug(const std::string &msg) { spdlog::debug(msg); }

} // namespace logger
