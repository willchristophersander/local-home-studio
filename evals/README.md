# Prompt checks

These cases compare a room brief with a known room. The brief is the model output. The program turns it into the editor's existing commands, commits that edit, and then runs the geometry check. A geometry warning is stored with the room; it does not roll the edit back.

Nothing here calls a model. A run with `"live": false` is a saved fixture.

## Add a room you measured

1. Copy `evals/cases/_new-room` to `evals/cases/<id>` and remove the leading underscore from the folder name.
2. Put photographs in that folder's `images/` directory. List each file in `case.json` with kind `metric`, `style`, or `walkthrough`.
3. Put the tape measurements in `expected.json`. A measurement the model must not override also goes in `case.json` under `locked`.
4. Leave `brief.json` for a saved model answer. The fixture briefs already in the other cases are inputs for the offline check, not model results.

`npm test` scores every case except folders whose names start with `_`. It does not read the photographs.

## Score one saved answer

Write `evals/runs/<name>/run.json` and `brief.json`. `run.json` names the case, the prompt file, the provider, and the model. Set `live` to true only when a model actually produced that brief. Then:

```
npm run eval:score -- evals/runs/<name>
```

Send the model `evals/prompts/room-brief-v1.md`, `evals/schema/room-brief.schema.json`, and `evals/schema/controls.json`, plus the case's locked measurements and the evidence notes. Keep the image files local.
