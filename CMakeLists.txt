cmake_minimum_required(VERSION 3.20)
project(AI_EXE_PHASE1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
option(BUILD_BACKEND_STUB "Build local inference backend contract stub" ON)

set(AI_EXE_MIN_WIDTH 1050 CACHE STRING "Minimum GUI width in pixels")
set(AI_EXE_MIN_HEIGHT 760 CACHE STRING "Minimum GUI height in pixels")
set(AI_EXE_DEFAULT_WIDTH 1220 CACHE STRING "Default GUI width in pixels" FORCE)
set(AI_EXE_DEFAULT_HEIGHT 830 CACHE STRING "Default GUI height in pixels" FORCE)
set(AI_EXE_SIDEBAR_DEFAULT_WIDTH 260 CACHE STRING "Default left sidebar width in pixels")
set(AI_EXE_SIDEBAR_MIN_WIDTH 200 CACHE STRING "Minimum left sidebar width in pixels")
set(AI_EXE_SIDEBAR_MAX_WIDTH 420 CACHE STRING "Maximum left sidebar width in pixels")
set(AI_EXE_RIGHT_DEFAULT_WIDTH 300 CACHE STRING "Default right sidebar width in pixels")
set(AI_EXE_RIGHT_MIN_WIDTH 260 CACHE STRING "Minimum right sidebar width in pixels")
set(AI_EXE_RIGHT_MAX_WIDTH 520 CACHE STRING "Maximum right sidebar width in pixels")
set(AI_EXE_MIDDLE_MIN_WIDTH 620 CACHE STRING "Minimum middle panel width in pixels")
set(AI_EXE_RESIZER_WIDTH 6 CACHE STRING "Panel resizer width in pixels")
option(AI_EXE_UI_ANIMATIONS_DEFAULT "Enable UI animations by default" ON)
option(AI_EXE_UI_REMEMBER_LAYOUT "Remember panel layout in local storage" ON)

if(AI_EXE_UI_ANIMATIONS_DEFAULT)
  set(AI_EXE_UI_ANIMATIONS_DEFAULT_CPP "true")
  set(AI_EXE_UI_ANIMATIONS_DEFAULT_JS "true")
else()
  set(AI_EXE_UI_ANIMATIONS_DEFAULT_CPP "false")
  set(AI_EXE_UI_ANIMATIONS_DEFAULT_JS "false")
endif()

if(AI_EXE_UI_REMEMBER_LAYOUT)
  set(AI_EXE_UI_REMEMBER_LAYOUT_CPP "true")
  set(AI_EXE_UI_REMEMBER_LAYOUT_JS "true")
else()
  set(AI_EXE_UI_REMEMBER_LAYOUT_CPP "false")
  set(AI_EXE_UI_REMEMBER_LAYOUT_JS "false")
endif()

file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/generated/ui")
configure_file(src/ui_constants.h.in "${CMAKE_BINARY_DIR}/generated/ui_constants.h" @ONLY)
configure_file(ui/ui-config.js.in "${CMAKE_BINARY_DIR}/generated/ui/ui-config.js" @ONLY)

if(APPLE)
  enable_language(OBJCXX)
endif()

if(MSVC)
  # Static runtime for self-contained binary packaging on Windows.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(AI_EXE_RUNTIME_SOURCES
  src/logger.cpp
  src/diagnostics.cpp
  src/sandbox.cpp
  src/memory_store.cpp
  src/rollback.cpp
  src/inference_engine.cpp
  src/process_runner.cpp
)

add_executable(ai_exe
  src/main.cpp
  ${AI_EXE_RUNTIME_SOURCES}
)

target_include_directories(ai_exe PRIVATE src)

if(WIN32)
  target_compile_definitions(ai_exe PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(ai_exe PRIVATE dxgi advapi32 comctl32)
endif()

if(WIN32)
  set(WIN_UI_HTML "${CMAKE_SOURCE_DIR}/ui/ai-exe.html")
  set(WIN_UI_CSS "${CMAKE_SOURCE_DIR}/ui/ai-exe.css")
  set(WIN_UI_JS "${CMAKE_SOURCE_DIR}/ui/ai-exe.js")
  set(WIN_UI_CONFIG_JS "${CMAKE_BINARY_DIR}/generated/ui/ui-config.js")
  set(WIN_UI_PROMPT_CHAT_MAIN "${CMAKE_SOURCE_DIR}/ui/prompts/chat_main.md")
  set(WIN_UI_PROMPT_AGENT "${CMAKE_SOURCE_DIR}/ui/prompts/developer_agent_decision.md")

  add_executable(ai_exe_gui WIN32
    src/gui_main_win_webview.cpp
    src/web_runtime_bridge.cpp
    src/inference_engine.cpp
    src/process_runner.cpp
  )

  target_include_directories(ai_exe_gui PRIVATE src "${CMAKE_BINARY_DIR}/generated")
  target_compile_definitions(ai_exe_gui PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(ai_exe_gui PRIVATE shlwapi ole32 advapi32 bcrypt)

  add_custom_command(TARGET ai_exe_gui POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:ai_exe_gui>/ui"
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompts"
    COMMAND ${CMAKE_COMMAND} -E rm -f "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompts/chat_namer.md"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_HTML}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/ai-exe.html"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_CSS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/ai-exe.css"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/ai-exe.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_CONFIG_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/ui-config.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_PROMPT_CHAT_MAIN}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompts/chat_main.md"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_PROMPT_AGENT}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompts/developer_agent_decision.md"
  )
endif()

if(APPLE)
  set(MAC_UI_HTML ui/ai-exe.html)
  set(MAC_UI_CSS ui/ai-exe.css)
  set(MAC_UI_JS ui/ai-exe.js)
  set(MAC_UI_CONFIG_JS "${CMAKE_BINARY_DIR}/generated/ui/ui-config.js")
  set(MAC_UI_PROMPT_CHAT_MAIN ui/prompts/chat_main.md)
  set(MAC_UI_PROMPT_AGENT ui/prompts/developer_agent_decision.md)
  set_source_files_properties(${MAC_UI_HTML} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_CSS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_CONFIG_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_PROMPT_CHAT_MAIN} PROPERTIES MACOSX_PACKAGE_LOCATION Resources/prompts)
  set_source_files_properties(${MAC_UI_PROMPT_AGENT} PROPERTIES MACOSX_PACKAGE_LOCATION Resources/prompts)

  add_executable(ai_exe_gui_mac MACOSX_BUNDLE
    src/gui_main_mac_web.mm
    src/web_runtime_bridge.cpp
    ${AI_EXE_RUNTIME_SOURCES}
    ${MAC_UI_HTML}
    ${MAC_UI_CSS}
    ${MAC_UI_JS}
    ${MAC_UI_CONFIG_JS}
    ${MAC_UI_PROMPT_CHAT_MAIN}
    ${MAC_UI_PROMPT_AGENT}
  )
  set_target_properties(ai_exe_gui_mac PROPERTIES
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/Info.plist.in"
  )

  target_include_directories(ai_exe_gui_mac PRIVATE src "${CMAKE_BINARY_DIR}/generated")
  target_compile_options(ai_exe_gui_mac PRIVATE -fobjc-arc)
  find_library(COCOA_FRAMEWORK Cocoa REQUIRED)
  find_library(WEBKIT_FRAMEWORK WebKit REQUIRED)
  find_library(AVFOUNDATION_FRAMEWORK AVFoundation REQUIRED)
  find_library(SPEECH_FRAMEWORK Speech REQUIRED)
  target_link_libraries(ai_exe_gui_mac PRIVATE
    ${COCOA_FRAMEWORK}
    ${WEBKIT_FRAMEWORK}
    ${AVFOUNDATION_FRAMEWORK}
    ${SPEECH_FRAMEWORK}
  )
  add_custom_command(TARGET ai_exe_gui_mac POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E rm -f "$<TARGET_BUNDLE_CONTENT_DIR:ai_exe_gui_mac>/Resources/prompts/chat_namer.md"
  )
endif()

if(BUILD_BACKEND_STUB)
  add_executable(infer_backend_stub
    src/infer_backend_stub.cpp
  )
endif()
