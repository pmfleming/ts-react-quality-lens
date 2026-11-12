import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { reactReviewRecords } from "../src/react-review.js";
import { measureReactHealth } from "../src/measures/react-health.js";
import { reactFixture } from "./react-improvement-helpers.js";

const wrap = (body: string) => `import {useState, useEffect} from 'react';
export function App({query}) { const [data,setData] = useState(null); const [name,setName] = useState(''); ${body} return <div>{name}</div>; }
`;
test("async Effect review recognizes local cleanup guards without trusting unrelated cleanup or shared flags", () => reactFixture((root, config) => {
  const cases: Array<[string, boolean]> = [
    ["useEffect(() => { fetch(query).then(value => setData(value)); }, [query]);", true],
    ["useEffect(() => { let ignore=false; fetch(query).then(value => { if(!ignore) setData(value); }); return () => {ignore=true;}; }, [query]);", false],
    ["useEffect(() => { let active=true; fetch(query).then(value => { if(active) { setData(value); } }); return () => {active=false;}; }, [query]);", false],
    ["useEffect(() => { let ignore=false; fetch(query).then(value => setData(value)); return () => {ignore=true;}; }, [query]);", true],
    ["useEffect(() => { let ignore=false; fetch(query).then(value => { if(!ignore) setData(value); else setData(null); }); return () => {ignore=true;}; }, [query]);", true],
    ["useEffect(() => { async function load() { const value=await fetch(query); setData(value); } load(); }, [query]);", true],
    ["useEffect(() => { const load=async () => { setData(await fetch(query)); }; load(); }, [query]);", true],
    ["useEffect(() => { async function unused() { const value=await fetch(query); setData(value); } }, [query]);", false],
    ["useEffect(() => { fetch(query).then(value => setData(value)); return () => controller.abort(); }, [query]);", true],
    ["let ignore=false; useEffect(() => { fetch(query).then(value => { if(!ignore) setData(value); }); return () => {ignore=true;}; }, [query]);", true],
    ["useEffect(() => { let ignore=false; fetch(query).then(value => { ignore=false; if(!ignore) setData(value); }); return () => {ignore=true;}; }, [query]);", true],
    ["useEffect(() => { let active=true; fetch(query).then(value => { if(active) setData(value); }); return () => active=false; }, [query]);", false],
    ["useEffect(() => { const active=true; fetch(query).then(value => { if(active) setData(value); }); return () => active=false; }, [query]);", true],
    ["useEffect(() => { let active=true; fetch(query).then(value => { active++; if(active) setData(value); }); return () => active=false; }, [query]);", true],
    ["useEffect(() => { let active=true; fetch(query).then(value => { if(active) setData(value); }); return () => active=true; }, [query]);", true],
    ["useEffect(() => { (async () => { setData(await fetch(query)); })(); }, [query]);", true],
    ["useEffect(() => { subscribe(value => setData(value)); return () => unsubscribe(); }, [query]);", false],
  ];
  for (const [body, expected] of cases) {
    fs.writeFileSync(path.join(root, "src/main.tsx"), wrap(body));
    const findings = reactReviewRecords(config, createAnalysisContext(config).project());
    assert.equal(findings.some((record) => record.kind === "async-effect-race"), expected, body);
    assert.ok(findings.every((record) => record.disposition === "review" && record.performance_verified === false));
  }
}));

test("Effect chains use local setter/dependency identities, group cycles, and exclude subscription callbacks", () => reactFixture((root, config) => {
  const body = "useEffect(() => { setData(query); }, [query]); useEffect(() => { setName(data); }, [data]);";
  const file = path.join(root, "src/main.tsx");
  fs.writeFileSync(file, wrap(body));
  const artifact = measureReactHealth(config, "chain");
  const chain = artifact.records.filter((record) => record.kind === "effect-state-chain");
  assert.equal(chain.length, 1);
  assert.equal(chain[0]?.disposition, "review");
  fs.writeFileSync(file, "// moved\n" + wrap(body));
  assert.equal(reactReviewRecords(config, createAnalysisContext(config).project()).find((record) => record.kind === "effect-state-chain")?.id, chain[0]?.id);
  for (const [code, expected] of [
    ["useEffect(() => { setData(name); }, [name]); useEffect(() => { setName(data); }, [data]);", 1],
    ["useEffect(() => { subscribe(() => setData(query)); }, [query]); useEffect(() => { setName(data); }, [data]);", 0],
    ["useEffect(() => { setData(query); }, [query]); useEffect(() => { setName(query); }, [query]);", 0],
  ] as const) {
    fs.writeFileSync(file, wrap(code));
    assert.equal(reactReviewRecords(config, createAnalysisContext(config).project()).filter((record) => record.kind === "effect-state-chain").length, expected);
  }
  fs.writeFileSync(file, wrap(body).replace("App({query})", "App({query}, useEffect)"));
  assert.ok(!reactReviewRecords(config, createAnalysisContext(config).project()).some((record) => record.kind === "effect-state-chain"));
}));
