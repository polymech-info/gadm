# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-src")
  file(MAKE_DIRECTORY "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-src")
endif()
file(MAKE_DIRECTORY
  "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-build"
  "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix"
  "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix/tmp"
  "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix/src/rapidjson-populate-stamp"
  "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix/src"
  "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix/src/rapidjson-populate-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix/src/rapidjson-populate-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "C:/Users/zx/Desktop/polymech/pm-pics/packages/gadm/cpp/build/_deps/rapidjson-subbuild/rapidjson-populate-prefix/src/rapidjson-populate-stamp${cfgdir}") # cfgdir has leading slash
endif()
