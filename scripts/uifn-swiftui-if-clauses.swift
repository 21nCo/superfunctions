// Lists every #if, #elseif and #else clause and #endif in the given Swift
// files as JSON, parsed by the toolchain's SwiftParser, so comments and
// string literals never read as directives and conditions come without
// trivia. scripts/uifn-swiftui-inventory.mjs runs it with the toolchain's
// host SwiftSyntax libraries and checks each clause against its builds.
//
//   swift -I <host> -L <host> -lSwiftParser -lSwiftSyntax scripts/uifn-swiftui-if-clauses.swift <file>...

import Foundation
import SwiftParser
import SwiftSyntax

final class IfClauses: SyntaxVisitor {
  let converter: SourceLocationConverter
  var clauses: [[String: Any]] = []

  init(_ converter: SourceLocationConverter) {
    self.converter = converter
    super.init(viewMode: .sourceAccurate)
  }

  override func visit(_ node: IfConfigDeclSyntax) -> SyntaxVisitorContinueKind {
    for clause in node.clauses {
      let condition = clause.condition.map { $0.tokens(viewMode: .sourceAccurate).map(\.text).joined(separator: " ") } ?? ""
      clauses.append(["line": clause.poundKeyword.startLocation(converter: converter).line, "directive": clause.poundKeyword.text, "condition": condition])
      if let elements = clause.elements { walk(elements) }
    }
    clauses.append(["line": node.poundEndif.startLocation(converter: converter).line, "directive": "#endif", "condition": ""])
    return .skipChildren
  }
}

var files: [String: Any] = [:]
for path in CommandLine.arguments.dropFirst() {
  let tree = Parser.parse(source: try String(contentsOfFile: path, encoding: .utf8))
  let visitor = IfClauses(SourceLocationConverter(fileName: path, tree: tree))
  visitor.walk(tree)
  files[path] = visitor.clauses
}
print(String(decoding: try JSONSerialization.data(withJSONObject: files, options: [.sortedKeys]), as: UTF8.self))
