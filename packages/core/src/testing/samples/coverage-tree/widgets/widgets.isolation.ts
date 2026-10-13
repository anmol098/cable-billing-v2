import { defineIsolationCases } from "../../../isolation";
import { getWidget, listWidgets } from "./widgets";

const seed = async () => ({ widgetId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });

export const getWidgetIsolation = defineIsolationCases(getWidget, {
  seed,
  cases: [{ name: "another tenant's widget", input: (s) => ({ widgetId: s.widgetId }) }],
});

export const listWidgetsIsolation = defineIsolationCases(listWidgets, {
  seed,
  cases: [{ name: "only own widgets", expect: "no_leak", input: () => ({}) }],
});

// exportWidgets has no cases: the coverage test must report it.
