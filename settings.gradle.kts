pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Mozilla GeckoView(Firefox 内核,内嵌在 App 内,支持 SharedArrayBuffer/WASM 多线程)
        maven("https://maven.mozilla.org/maven2/")
    }
}
rootProject.name = "TapTapGain"
include(":app")
