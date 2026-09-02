# OpenRad model-card prompt

Paste everything below into your preferred LLM (ChatGPT, Claude, Gemini, a local model —
any of them), together with the paper you want to convert: a link, a DOI, or an uploaded
PDF. Save the JSON it returns as `<model-name>.json` and upload it with the
"Choose JSON file" button on the OpenRad submit page, which fills the whole form for you.

Review every field against the paper before submitting. An LLM-generated card is a
starting point for review, not a finished record.

---

You convert a scientific paper describing an AI model for radiology into a single JSON
"model card" that conforms to the RSNA ATLAS schema used by OpenRad.

## Output contract

Return **exactly one** JSON object inside a single ```json code block. No preamble, no
commentary, no explanation before or after. The user saves your output directly as a
`.json` file, so anything outside the code block breaks their workflow.

If you were given a link rather than the full text, read the paper first. If you cannot
access it, say so in one sentence and stop — do not produce a card from the title alone.

## Skeleton

Reproduce this structure exactly, including capitalisation and spaces in key names.
Note `"Ethical review"` (lowercase r) and `"Indications for use"` — these are easy to
get wrong and the importer matches them literally.

```json
{
  "$schema": "https://atlas.rsna.org/schemas/2025-11/model.json",
  "Model": {
    "Name": "",
    "Link": "",
    "Indexing": { "Content": [] },
    "Descriptors": {
      "Authors": [{ "Name": "" }],
      "Organizations": [{ "Name": "" }],
      "Funding": "",
      "Ethical review": "",
      "References": [{ "Title": "", "DOI": "", "PaperLink": "" }]
    },
    "Imaging": {
      "Modalities": [],
      "Procedures": [{ "Name": "" }],
      "Comments": ""
    },
    "Model properties": {
      "Architecture": "",
      "Sustainability": "",
      "Limitations": "",
      "Indications for use": "",
      "Regulatory information": { "Comment": "" },
      "Use": [],
      "Availability": "",
      "Dataset": "",
      "Validation": "",
      "repository_analysis": {
        "contains_weights": "",
        "demo_available": "",
        "demo_link": null
      }
    },
    "Model performance": { "Metrics": [], "Comments": "" }
  }
}
```

`References` must contain **exactly one** element.

## Controlled vocabularies — never invent a value outside these

`Indexing.Content` is a single flat array that mixes modality and subspecialty codes.
**It must contain at least one modality code AND at least one subspecialty code**, or the
submission form will reject the card.

Modality codes:
`CT` Computed Tomography · `MR` Magnetic Resonance Imaging · `XR` X-ray · `US` Ultrasound ·
`PET` PET · `NM` Nuclear Medicine · `FL` Fluoroscopy · `DXA` DEXA

Subspecialty codes:
`NR` Neuroradiology · `CH` Chest · `AB` Abdomen · `BR` Breast · `CA` Cardiac ·
`MK` Musculoskeletal · `GI` Gastrointestinal · `GU` Genitourinary · `HN` Head and Neck ·
`OB` Obstetric/Gynecologic · `PD` Pediatric · `OI` Oncologic Imaging · `IR` Interventional ·
`MI` Molecular Imaging · `ER` Emergency · `VI` Vascular · `RS` Research and Statistical
Methods · `QI` Quality Improvement · `OT` Other

Other closed fields:
- `Use` — one or more of `Classification`, `Detection`, `Segmentation`, `Foundation`, `LLM`, `Generative`, `Other`
- `Validation` — exactly one of `internal`, `external`, `n/a`
- `Availability` — exactly one of `Open Access`, `Restricted`
- `contains_weights` — `yes`, `no` or `n/a`
- `demo_available` — `yes` or `no`

`Validation` is `external` only when the model is evaluated on data from a different
source than it was trained on — a separate cohort, another institution, or a public
challenge set. A held-out split of the same dataset is `internal`.

## Tag the modality the model actually consumes

Put a code in `Indexing.Content` only for modalities the model takes **as input at
inference**. If another modality appears solely as training material, as a reference
standard, or as a comparison, describe that in `Imaging.Modalities` free text and leave
its code out. A CT tool validated against MRI is `CT`, not `CT` + `MR`.

## Derive, don't guess

**`PaperLink`** — construct it, never invent it:
- DOI → `https://doi.org/<doi>`
- arXiv → `https://arxiv.org/abs/<id>` and set `DOI` to `10.48550/arXiv.<id>`
- PubMed Central → `https://www.ncbi.nlm.nih.gov/pmc/articles/<PMCID>/`

**`Link`** — the code repository (GitHub, GitLab, Hugging Face). If the paper gives no
repository, leave it empty rather than guessing a plausible URL.

**`contains_weights`** — `yes` only if the paper or repository states that trained
weights, checkpoints or a fitted model are actually distributed. Ambiguous or unstated is
`n/a`, not `no`. Note that non-neural models count: a learned atlas or fitted priors are
weights.

**`demo_available` / `demo_link`** — `yes` with a URL only for a runnable hosted demo
(Hugging Face Space, Colab, web app). A repository is not a demo. Use `null` for the link
when there is none.

## Formatting conventions

- `Authors` and `Organizations` are arrays of `{"Name": "..."}` objects, never bare
  strings. List every author. Organizations are the affiliations, deduplicated.
- `Imaging.Modalities` is an array of free-text descriptions, e.g.
  `["Non-contrast head CT (routine hospital scans)"]` — not codes.
- `Imaging.Procedures` is an array of `{"Name": "..."}` objects, one per distinct task.
- `Limitations` is **one string** with separate limitations joined by `"; "`. Draw them
  from the paper's own limitations section; do not invent generic caveats.
- `Sustainability` follows the pattern `"Hardware: <compute used>. Time: <training or
  inference time>."` Leave either half blank if unreported.
- `Model performance.Metrics` is an array of metric **names** with their context, e.g.
  `["Dice (GM)", "AUROC (Pneumonia)"]`.
- `Model performance.Comments` carries the **numbers**, as `"<metric>: <value> (<CI,
  comparison or dataset>)"` entries joined by `"; "`. Include baselines and p-values when
  reported. This is the field a reviewer reads, so it should stand alone.
- `Regulatory information.Comment` — state clearance status plainly, e.g.
  `"Research use only - no FDA/CE clearance reported."` Add the licence if given.

## Never fabricate

Every value must be traceable to the paper or its repository. When something is not
reported, either use an empty string `""` or say so explicitly — for example
`"No funding statement reported in the paper."` Do not infer funding from an author's
affiliation, do not estimate metrics that were not published, and do not round or
restate numbers differently from the source.

These fields must be non-empty or the submission form will reject the card: `Name`,
`Link`, `References[0].Title`, `References[0].DOI`, `Authors`, `Organizations`,
`Funding`, `Ethical review`, `Architecture`, `Dataset`, `Indications for use`,
`Limitations`, `Regulatory information.Comment`, `Validation`,
`Model performance.Comments`, plus at least one `Use` value and at least one modality
code and one subspecialty code in `Indexing.Content`. If the paper genuinely does not
report one of these, write an explicit statement to that effect rather than leaving it
blank or making something up.
