/**
 * PHASE_14 plugin tests: TV-PLUG-001 (custom widget used), TV-PLUG-002 (last wins).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { registerWidget, getWidgetForField } from "../plugins/registerWidget.js";
import { renderField } from "../editor/renderField.js";
import type { ContentfnField } from "@contentfn/core";

// Reset module state between tests by re-registering; we test in order so no shared state across files.
const fieldBody: ContentfnField = {
  name: "body",
  type: { kind: "richtext" },
  required: false,
};

describe("PHASE_14: Widget extension", () => {
  describe("TV-PLUG-001: register custom widget", () => {
    it("custom widget is used for that field when registered", () => {
      registerWidget(
        { typeName: "post", fieldName: "body" },
        (props) => <div data-custom-widget="custom-body" data-value={String(props.value)}>{String(props.value)}</div>
      );

      const result = renderField(
        fieldBody,
        "body",
        "initial",
        () => {},
        null,
        { docTypeName: "post" }
      );
      const { container } = render(<>{result}</>);
      expect(container.querySelector('[data-custom-widget="custom-body"]')).toBeTruthy();
      expect(container.querySelector('[data-custom-widget="custom-body"]')?.getAttribute("data-value")).toBe("initial");
    });
  });

  describe("TV-PLUG-002: widget conflict resolved deterministically (last wins)", () => {
    it("second registration for same selector wins", () => {
      registerWidget({ typeName: "post", fieldName: "body" }, () => <span data-widget-id="first" />);
      registerWidget({ typeName: "post", fieldName: "body" }, () => <span data-widget-id="second" />);

      const result = renderField(fieldBody, "body", null, () => {}, null, { docTypeName: "post" });
      const { container } = render(<>{result}</>);
      expect(container.querySelector('[data-widget-id="second"]')).toBeTruthy();
      expect(container.querySelector('[data-widget-id="first"]')).toBeFalsy();
    });
  });
});

describe("getWidgetForField", () => {
  beforeEach(() => {
    // Rely on test order: no global reset of registry
  });

  it("returns null when no widget registered", () => {
    const c = getWidgetForField("unknownType", "unknownField", "primitive");
    expect(c).toBeNull();
  });
});


describe("Public widget registration", () => {
  it("exposes typed registration and keeps specific/last precedence through the public editor", async () => {
    const { registerWidget: register, renderField: renderPublic } = await import('../index.js');
    const selector = { typeName: 'public-post', fieldName: 'literal.title' };
    register(selector, () => <span data-public-widget="first" />);
    register(selector, props => <input aria-label="Custom literal" value={String(props.value)} onChange={event => props.onChange(event.target.value)} data-public-widget="winner" />);
    register({ fieldName: 'literal.title' }, () => <span data-public-widget="less-specific" />);
    selector.fieldName = 'changed-after-registration';
    let changed: unknown;
    const { container } = render(<>{renderPublic({name:'literal.title',type:{kind:'primitive',type:'string'}}, 'literal.title', 'original', value=>{changed=value;}, null, {docTypeName:'public-post'})}</>);
    const input = screen.getByRole('textbox',{name:'Custom literal'});
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input,{target:{value:'edited'}});
    expect(changed).toBe('edited');
    expect(container.querySelector('[data-public-widget="winner"]')).toBeTruthy();
    expect(container.querySelector('[data-public-widget="first"],[data-public-widget="less-specific"]')).toBeNull();
  });

  it("rejects malformed JavaScript registrations without admitting or invoking them", async () => {
    const { registerWidget: register } = await import('../index.js');
    let accessorReads = 0, componentCalls = 0;
    const winner = () => { componentCalls++; return <span />; };
    register({typeName:'protected',fieldName:'title'},winner);
    const selectors: unknown[] = [null, [], {}, {typeName:5}, {fieldName:''}, {fieldType:false}, {typeName:'protected',fieldName:'title',source:'code'},
      Object.create({fieldName:'title'}), {fieldName:'title',[Symbol('extra')]:true},
      Object.defineProperty({},'fieldName',{get(){accessorReads++;throw new Error('must not run');}})];
    for(const selector of selectors)expect(()=>Reflect.apply(register,undefined,[selector,winner])).toThrow('Invalid widget registration');
    for(const component of [null,{},'function() {}',42])expect(()=>Reflect.apply(register,undefined,[{typeName:'protected',fieldName:'title'},component])).toThrow('Invalid widget registration');
    expect(getWidgetForField('protected','title','primitive')).toBe(winner);
    expect(accessorReads).toBe(0); expect(componentCalls).toBe(0);
  });
});
