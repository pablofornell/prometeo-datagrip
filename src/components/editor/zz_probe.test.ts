// @vitest-environment node
import { it } from "vitest";
import { lex } from "./lexer";
import { SchemaIndex } from "./schemaIndex";
import { analyzeStatement } from "./semantic";
import type { Dialect } from "./split";
const index = new SchemaIndex({ schemas: [{ name: "public", tables: [
 { name: "t", kind: "table", columns: [{ name: "id", type: "int" },{ name: "a", type: "int" }, { name: "b", type: "int" }, { name: "name", type: "text" }] },
 { name: "u", kind: "table", columns: [{ name: "a", type: "int" }, { name: "c", type: "int" }] }] }] }, "public");
const P = (sql: string, d: Dialect) => analyzeStatement(sql, lex(sql, d), index, d).unresolved.map((u) => `${u.kind}:${sql.slice(u.from, u.to)}`);
it("probe", () => {
  const cases: [string, Dialect][] = [
   ["with recursive r(n) as (select 1 union all select n+1 from r where n<5) select n from r","postgres"],
   ["with recursive r(n) as (select 1 union all select n+1 from r where n<5) select n from r","sqlite"],
   ["with recursive r(n) as (select 1 union all select n+1 from r where n<5) select n from r","mysql"],
   ["with x as (select a from t) select x.a from x","postgres"],
   ["insert into t(id,name) values (1,'a') on conflict (id) do update set name = excluded.name","postgres"],
   ["insert into t(id,name) values (1,'a') on conflict (id) do update set name = excluded.name","sqlite"],
   ["insert into t(id,name) values (1,'a') on conflict (id) do update set name = excluded.name where t.a > 1","postgres"],
   ["insert into t(id,name) values (1,'a') on conflict on constraint t_pkey do nothing","postgres"],
   ["insert into t(a) values (1) as nw on duplicate key update a = nw.a","mysql"],
   ["insert into t(a) values (1) as nw(x) on duplicate key update a = nw.x","mysql"],
   ["insert into t(a) values (1) on duplicate key update a = values(a)","mysql"],
   ["insert into t(a,b) values (1,2) on duplicate key update a = values(a), b = b + 1","mysql"],
   ["insert into t(a) values (1) returning id, name","postgres"],
   ["insert into t(a) select a from u returning t.id","postgres"],
   ["update t set a = u.c from u where t.a = u.a","postgres"],
   ["update t set a = x.c from (select a, c from u) x where t.a = x.a","postgres"],
   ["update t set a = u.c from u where t.a = u.a returning t.id, u.c","postgres"],
   ["update t join u on t.a = u.a set t.b = u.c","mysql"],
   ["merge into t using u on t.a = u.a when matched then update set b = u.c when not matched then insert (a) values (u.a)","postgres"],
   ["merge into t as tt using (select a, c from u) s on tt.a = s.a when matched then update set b = s.c when not matched then insert (a) values (s.a)","postgres"],
   ["merge into t using u on t.a = u.a when matched then delete","postgres"],
   ["select * from t, lateral (select c from u where u.a = t.a) l","postgres"],
   ["select t.a, l.c from t cross join lateral (select c from u where u.a = t.a) l","postgres"],
   ["select t.a, l.c from t left join lateral (select c from u where u.a = t.a) l on true","postgres"],
   ["select t.a, l.c from t join lateral (select c from u where u.a = t.a) as l(c) on true","postgres"],
   ["select t.a, l.c from t, lateral (select c from u where u.a = t.a) as l","mysql"],
   ["with x as (select a from t) insert into u (a) select a from x","postgres"],
   ["with d as (delete from t where a = 1 returning *) select * from d","postgres"],
   ["with a as (select 1 as n), b as (select n from a) select b.n from b","postgres"],
   ["select nope from t","postgres"],
   ["insert into t(a) values (1) on conflict (id) do update set name = nope.name","postgres"],
   ["insert into t(a) values (1) as nw on duplicate key update a = zz.a","mysql"],
   ["with recursive r(n) as (select 1 union all select n+1 from r where n<5) select zz.n from r","postgres"],
  ];
  for (const [s,d] of cases) console.log(d.padEnd(8), JSON.stringify(P(s,d)), s);
});
