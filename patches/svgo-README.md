# svgo@4.1.0

`lib/path.js` `stringifyPathData` merged consecutive path commands with `prev.args = [...prev.args, ...args]`, which copies the whole accumulated run on every command. A long path or polygon was therefore quadratic: 200 KB took 25.8 s and held the back end's only SVG worker past its 15 s deadline, from one staff upload. The patch copies the run once and appends. Output is byte-identical.

`apps/back-end/tests/unit/svg-optimize-cost.test.ts` fails if an update drops the patch. Before bumping svgo, check whether upstream fixed the writer; if it did, delete the patch and this file.
