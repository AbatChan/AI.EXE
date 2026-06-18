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
option(AI_EXE_ENABLE_REMOTE_PROVIDERS "Enable hosted/API inference providers in the UI" ON)
option(AI_EXE_ENABLE_DEV_PLANNER "Enable localhost development planner endpoint in the UI" OFF)
set(AI_EXE_WEBVIEW2_DIR "" CACHE PATH "Microsoft.Web.WebView2 NuGet package root (provides WebView2.h + WebView2Loader.dll for the Windows GUI). Without it the GUI builds in a non-rendering fallback mode.")
set(AI_EXE_APP_VERSION "4.4.1" CACHE STRING "AI.EXE app and UI version" FORCE)
set(AI_EXE_BUILD_TAG "per-file-default-plus-infer-logs" CACHE STRING "Human-readable AI.EXE build tag" FORCE)
set(AI_EXE_BUILD_LABEL "v${AI_EXE_APP_VERSION} (${AI_EXE_BUILD_TAG} 2026-06-16)")

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

if(AI_EXE_ENABLE_REMOTE_PROVIDERS)
  set(AI_EXE_ENABLE_REMOTE_PROVIDERS_CPP "true")
  set(AI_EXE_ENABLE_REMOTE_PROVIDERS_JS "true")
else()
  set(AI_EXE_ENABLE_REMOTE_PROVIDERS_CPP "false")
  set(AI_EXE_ENABLE_REMOTE_PROVIDERS_JS "false")
endif()

if(AI_EXE_ENABLE_DEV_PLANNER)
  set(AI_EXE_ENABLE_DEV_PLANNER_JS "true")
else()
  set(AI_EXE_ENABLE_DEV_PLANNER_JS "false")
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
  enable_language(RC)  # compile src/app.rc (the .exe icon)
  set(WIN_UI_HTML "${CMAKE_SOURCE_DIR}/ui/ai-exe.html")
  set(WIN_UI_CSS "${CMAKE_SOURCE_DIR}/ui/ai-exe.css")
  set(WIN_UI_JS "${CMAKE_SOURCE_DIR}/ui/ai-exe.js")
  set(WIN_MARKDOWN_RENDERER_JS "${CMAKE_SOURCE_DIR}/ui/markdown-renderer.js")
  set(WIN_PROMPT_CORE_JS "${CMAKE_SOURCE_DIR}/ui/prompt-core.js")
  set(WIN_AGENT_CORE_JS "${CMAKE_SOURCE_DIR}/ui/agent-core.js")
  set(WIN_AGENT_PLANNER_JS "${CMAKE_SOURCE_DIR}/ui/agent-planner.js")
  set(WIN_AGENT_RUNTIME_JS "${CMAKE_SOURCE_DIR}/ui/agent-runtime.js")
  set(WIN_AGENT_EXECUTOR_JS "${CMAKE_SOURCE_DIR}/ui/agent-executor.js")
  set(WIN_AGENT_LOOP_JS "${CMAKE_SOURCE_DIR}/ui/agent-loop.js")
  set(WIN_CHAT_SHELL_JS "${CMAKE_SOURCE_DIR}/ui/chat-shell.js")
  set(WIN_CHAT_RENDERER_JS "${CMAKE_SOURCE_DIR}/ui/chat-renderer.js")
  set(WIN_FILE_VIEWER_JS "${CMAKE_SOURCE_DIR}/ui/file-viewer.js")
  set(WIN_PREFLIGHT_ROUTER_JS "${CMAKE_SOURCE_DIR}/ui/preflight-router.js")
  set(WIN_WORKSPACE_CORE_JS "${CMAKE_SOURCE_DIR}/ui/workspace-core.js")
  set(WIN_WORKSPACE_ACTIONS_JS "${CMAKE_SOURCE_DIR}/ui/workspace-actions.js")
  set(WIN_WORKSPACE_RENDERER_JS "${CMAKE_SOURCE_DIR}/ui/workspace-renderer.js")
  set(WIN_UI_CONFIG_JS "${CMAKE_BINARY_DIR}/generated/ui/ui-config.js")
  set(WIN_UI_PROMPTS_DIR "${CMAKE_SOURCE_DIR}/ui/prompts")
  set(WIN_UI_VENDOR_DIR "${CMAKE_SOURCE_DIR}/ui/vendor")

  add_executable(ai_exe_gui WIN32
    src/gui_main_win_webview.cpp
    src/web_runtime_bridge.cpp
    src/inference_engine.cpp
    src/process_runner.cpp
    src/local_app_server.cpp
    src/app.rc
  )

  target_include_directories(ai_exe_gui PRIVATE src "${CMAKE_BINARY_DIR}/generated")
  if(AI_EXE_WEBVIEW2_DIR)
    # Puts WebView2.h on the include path so __has_include(<WebView2.h>) is true
    # and the GUI compiles with real WebView2 rendering (not the fallback window).
    target_include_directories(ai_exe_gui PRIVATE "${AI_EXE_WEBVIEW2_DIR}/build/native/include")
  endif()
  target_compile_definitions(ai_exe_gui PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(ai_exe_gui PRIVATE shlwapi ole32 advapi32 bcrypt dwmapi ws2_32)

  add_custom_command(TARGET ai_exe_gui POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:ai_exe_gui>/ui"
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompts"
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:ai_exe_gui>/ui/vendor"
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
      "${WIN_MARKDOWN_RENDERER_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/markdown-renderer.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_PROMPT_CORE_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompt-core.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_AGENT_CORE_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/agent-core.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_AGENT_PLANNER_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/agent-planner.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_AGENT_RUNTIME_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/agent-runtime.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_AGENT_EXECUTOR_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/agent-executor.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_AGENT_LOOP_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/agent-loop.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_CHAT_SHELL_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/chat-shell.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_CHAT_RENDERER_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/chat-renderer.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_FILE_VIEWER_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/file-viewer.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_PREFLIGHT_ROUTER_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/preflight-router.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_WORKSPACE_CORE_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/workspace-core.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_WORKSPACE_ACTIONS_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/workspace-actions.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_WORKSPACE_RENDERER_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/workspace-renderer.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${WIN_UI_CONFIG_JS}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/ui-config.js"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${WIN_UI_PROMPTS_DIR}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/prompts"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${WIN_UI_VENDOR_DIR}"
      "$<TARGET_FILE_DIR:ai_exe_gui>/ui/vendor"
  )
endif()

if(APPLE)
  set(MAC_UI_HTML ui/ai-exe.html)
  set(MAC_UI_CSS ui/ai-exe.css)
  set(MAC_UI_JS ui/ai-exe.js)
  set(MAC_MARKDOWN_RENDERER_JS ui/markdown-renderer.js)
  set(MAC_PROMPT_CORE_JS ui/prompt-core.js)
  set(MAC_AGENT_CORE_JS ui/agent-core.js)
  set(MAC_AGENT_PLANNER_JS ui/agent-planner.js)
  set(MAC_AGENT_RUNTIME_JS ui/agent-runtime.js)
  set(MAC_AGENT_EXECUTOR_JS ui/agent-executor.js)
  set(MAC_AGENT_LOOP_JS ui/agent-loop.js)
  set(MAC_CHAT_SHELL_JS ui/chat-shell.js)
  set(MAC_CHAT_RENDERER_JS ui/chat-renderer.js)
  set(MAC_FILE_VIEWER_JS ui/file-viewer.js)
  set(MAC_PREFLIGHT_ROUTER_JS ui/preflight-router.js)
  set(MAC_WORKSPACE_CORE_JS ui/workspace-core.js)
  set(MAC_WORKSPACE_ACTIONS_JS ui/workspace-actions.js)
  set(MAC_WORKSPACE_RENDERER_JS ui/workspace-renderer.js)
  set(MAC_UI_CONFIG_JS "${CMAKE_BINARY_DIR}/generated/ui/ui-config.js")
  file(GLOB MAC_UI_PROMPT_FILES ui/prompts/*.md)
  set(MAC_UI_VENDOR_DIR ui/vendor)
  set_source_files_properties(${MAC_UI_HTML} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_CSS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_MARKDOWN_RENDERER_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_PROMPT_CORE_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_AGENT_CORE_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_AGENT_PLANNER_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_AGENT_RUNTIME_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_AGENT_EXECUTOR_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_AGENT_LOOP_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_CHAT_SHELL_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_CHAT_RENDERER_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_FILE_VIEWER_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_PREFLIGHT_ROUTER_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_WORKSPACE_CORE_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_WORKSPACE_ACTIONS_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_WORKSPACE_RENDERER_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_CONFIG_JS} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(${MAC_UI_PROMPT_FILES} PROPERTIES MACOSX_PACKAGE_LOCATION Resources/prompts)

  add_executable(ai_exe_gui_mac MACOSX_BUNDLE
    src/gui_main_mac_web.mm
    src/web_runtime_bridge.cpp
    src/local_app_server.cpp
    ${AI_EXE_RUNTIME_SOURCES}
    ${MAC_UI_HTML}
    ${MAC_UI_CSS}
    ${MAC_UI_JS}
    ${MAC_MARKDOWN_RENDERER_JS}
    ${MAC_PROMPT_CORE_JS}
    ${MAC_AGENT_CORE_JS}
    ${MAC_AGENT_PLANNER_JS}
    ${MAC_AGENT_RUNTIME_JS}
    ${MAC_AGENT_EXECUTOR_JS}
    ${MAC_AGENT_LOOP_JS}
    ${MAC_CHAT_SHELL_JS}
    ${MAC_CHAT_RENDERER_JS}
    ${MAC_FILE_VIEWER_JS}
    ${MAC_PREFLIGHT_ROUTER_JS}
    ${MAC_WORKSPACE_CORE_JS}
    ${MAC_WORKSPACE_ACTIONS_JS}
    ${MAC_WORKSPACE_RENDERER_JS}
    ${MAC_UI_CONFIG_JS}
    ${MAC_UI_PROMPT_FILES}
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
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${CMAKE_SOURCE_DIR}/ui/prompts"
      "$<TARGET_BUNDLE_CONTENT_DIR:ai_exe_gui_mac>/Resources/prompts"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${CMAKE_SOURCE_DIR}/${MAC_UI_VENDOR_DIR}"
      "$<TARGET_BUNDLE_CONTENT_DIR:ai_exe_gui_mac>/Resources/vendor"
  )
endif()

if(BUILD_BACKEND_STUB)
  add_executable(infer_backend_stub
    src/infer_backend_stub.cpp
  )
  # The app expects the local-inference adapter as "infer_backend(.exe)".
  set_target_properties(infer_backend_stub PROPERTIES OUTPUT_NAME infer_backend)
endif()
