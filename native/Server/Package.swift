// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "EpiCastServer", platforms: [.macOS(.v14)],
    products: [.executable(name: "EpiCastServer", targets: ["EpiCastServer"])],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", exact: "4.122.2"),
        .package(url: "https://github.com/jpsim/Yams.git", exact: "6.0.2")
    ], targets: [
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3"),
        .target(name: "ServerCore", dependencies: ["CSQLite", .product(name: "Vapor", package: "vapor"), .product(name: "Yams", package: "Yams")], resources: [.copy("Resources/prompts.json")]),
        .executableTarget(name: "EpiCastServer", dependencies: ["ServerCore"]),
        .testTarget(name: "ServerCoreTests", dependencies: ["ServerCore"], resources: [.copy("Fixtures")])
    ])
