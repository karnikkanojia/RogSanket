// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "EpiCast", platforms: [.macOS(.v14)],
    products: [.executable(name: "EpiCast", targets: ["EpiCast"])],
    targets: [.executableTarget(name: "EpiCast")])
