#!/usr/bin/env python3
"""Require complete local Doxygen contracts on named production C++ definitions."""

import argparse
import json
import re
from pathlib import Path

from tree_sitter import Language, Parser
import tree_sitter_cpp


def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)


def text(node, source):
    return source[node.start_byte:node.end_byte].decode("utf-8") if node else ""


def declarator_name(node, source):
    """Follow declarators without confusing parameter types with argument names."""
    if node is None:
        return ""
    child = node.child_by_field_name("declarator")
    if child:
        return declarator_name(child, source)
    if node.type in {"reference_declarator", "parenthesized_declarator"}:
        return declarator_name(node.named_children[0], source) if node.named_children else ""
    if node.type == "qualified_identifier":
        name = node.child_by_field_name("name")
        if name and name.type == "pointer_type_declarator":
            return declarator_name(name, source)
    if node.type in {"identifier", "field_identifier", "qualified_identifier",
                     "destructor_name", "operator_name", "type_identifier"}:
        return text(node, source)
    return ""


def local_comment(function, source):
    """A declaration's header comment never substitutes for its source contract."""
    anchor = function
    while anchor.parent and (anchor.parent.type == "template_declaration"
                             or (anchor.parent.type == "linkage_specification"
                                 and anchor.parent.child_by_field_name("body") == anchor)):
        anchor = anchor.parent
    previous = anchor.prev_named_sibling
    end = anchor.start_byte
    while previous and previous.type == "comment":
        if source[previous.end_byte:end].strip():
            break
        comment = text(previous, source)
        if comment.startswith(("/**", "/*!", "///", "//!")):
            return comment
        end = previous.start_byte
        previous = previous.prev_named_sibling
    return ""


def inspect(path, root, parser):
    source = path.read_bytes()
    tree = parser.parse(source)
    result = []
    parse_errors = []
    for node in walk(tree.root_node):
        if node.type == "ERROR" or node.is_missing:
            # SDK macros may confuse a statement inside a correctly parsed body.
            # An error outside a body could hide a definition, so fail closed.
            parent = node.parent
            while parent and parent.type not in {"function_definition", "translation_unit"}:
                parent = parent.parent
            if not parent or parent.type != "function_definition":
                parse_errors.append(f"{path.relative_to(root)}:{node.start_point.row + 1}: "
                                    "unparsed C++ outside a function body")
        if node.type != "function_definition":
            continue
        ancestor = node.parent
        while ancestor and ancestor.type not in {"function_definition", "class_specifier",
                                                   "struct_specifier", "translation_unit"}:
            ancestor = ancestor.parent
        if ancestor and ancestor.type == "function_definition":
            # A statement macro such as cJSON_ArrayForEach(...) { ... } can look
            # like a definition to a parser without macro expansion. C++ forbids
            # nested named functions; local-class methods remain included above.
            continue
        declaration = node.child_by_field_name("declarator")
        name = declarator_name(declaration, source)
        if not name:
            name = text(declaration, source).split("(", 1)[0].strip()
        function_declarator = next((child for child in walk(declaration)
                                    if child.type == "function_declarator"), None)
        parameters = function_declarator.child_by_field_name("parameters") if function_declarator else None
        names = [declarator_name(parameter.child_by_field_name("declarator"), source)
                 for parameter in parameters.named_children
                 if parameter.type in {"parameter_declaration", "optional_parameter_declaration"}] if parameters else []
        names = [name for name in names if name]
        comment = local_comment(node, source)
        problems = []
        if not comment:
            problems.append("missing adjacent Doxygen comment")
        else:
            if not re.search(r"[@\\]brief\s+\S", comment):
                problems.append("missing @brief")
            documented = set(re.findall(r"[@\\]param\s*(?:\[[^\]]*\])?\s+([A-Za-z_][A-Za-z_0-9]*)", comment))
            missing = set(names) - documented
            extra = documented - set(names)
            if missing:
                problems.append("missing @param " + ", ".join(sorted(missing)))
            if extra:
                problems.append("unknown @param " + ", ".join(sorted(extra)))
            return_type = text(node.child_by_field_name("type"), source)
            pointer_return = declaration and declaration.type == "pointer_declarator"
            if ((return_type and (return_type != "void" or pointer_return))
                    or (declaration and declaration.type == "operator_cast")):
                if not re.search(r"[@\\](?:return|returns|retval)\b", comment):
                    problems.append("missing @return")
        result.append({"file": str(path.relative_to(root)), "line": node.start_point.row + 1,
                       "name": name, "parameters": names, "problems": problems})
    return result, parse_errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="Write the complete coverage report")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    cpp_parser = Parser(Language(tree_sitter_cpp.language()))
    functions = []
    parse_errors = []
    paths = sorted((root / "firmware/base/main").rglob("*.cpp"))
    for path in paths:
        found, errors = inspect(path, root, cpp_parser)
        functions.extend(found)
        parse_errors.extend(errors)
    failures = [function for function in functions if function["problems"]]
    for function in failures:
        print(f'{function["file"]}:{function["line"]}: {function["name"]}: '
              + "; ".join(function["problems"]))
    for error in parse_errors:
        print(error)
    print(f"FCPLCn Doxygen: {len(functions) - len(failures)}/{len(functions)} named definitions "
          f"documented in {len(paths)} .cpp files; {len(parse_errors)} structural parse errors.")
    if args.json:
        args.json.write_text(json.dumps({"functions": functions, "parseErrors": parse_errors},
                                       ensure_ascii=False, indent=2) + "\n")
    return bool(failures or parse_errors or not functions)


if __name__ == "__main__":
    raise SystemExit(main())
