# Third-party notices

Warden source is licensed under [Apache-2.0](LICENSE). Dependencies, downloaded
models and administrator-imported weights retain their own licenses. This file
records the direct runtime dependencies and the additional OCR runtime used by
the document feature; it is not a complete flattened inventory of every
transitive native library in Electron or QVAC.

Versions below were checked against the installed package manifests and
`pnpm-lock.yaml` on 2026-09-08. Document/parser/OCR direct dependencies are pinned
exactly in `package.json`. Existing caret ranges remain reproducible through the
lockfile. Package license files and bundled notices remain authoritative.

## Runtime dependencies

| Package | Resolved version | Declared license | Purpose / source |
| --- | --- | --- | --- |
| `@qvac/sdk` | 0.17.1 | Apache-2.0 | [Local model runtime](https://github.com/tetherto/qvac); includes its own model and dependency notices |
| `express` | 5.2.1 | MIT | [HTTP server](https://github.com/expressjs/express) |
| `zod` | 4.4.3 | MIT | [Input and model-output validation](https://github.com/colinhacks/zod) |
| `require-asset` | 1.2.2 | Apache-2.0 | [Runtime asset resolution](https://github.com/holepunchto/require-asset) |
| `pdfjs-dist` | 6.3.289 | Apache-2.0 | [PDF text, forms, rendering and source images](https://github.com/mozilla/pdf.js) |
| `@napi-rs/canvas` | 1.0.8 | MIT | [Native canvas used to render PDF pages for OCR](https://github.com/Brooooooklyn/canvas) |
| `image-size` | 2.0.4 | MIT | [Dimensions before decoding untrusted images](https://github.com/image-size/image-size) |
| `yauzl` | 3.4.0 | MIT | [Bounded DOCX ZIP inspection](https://github.com/thejoshwolfe/yauzl) |
| `saxes` | 6.0.0 | ISC | [DOCX XML parsing](https://github.com/lddubeau/saxes) |
| `tesseract.js` | 7.0.0 | Apache-2.0 | [Offline OCR worker interface](https://github.com/naptha/tesseract.js) |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | [Transitive OCR WebAssembly runtime](https://github.com/naptha/tesseract.js-core) |
| `@tesseract.js-data/eng` | 1.0.0 | MIT in npm metadata; see trained data below | [Bundled English OCR data](https://github.com/naptha/tessdata) |
| `@tesseract.js-data/spa` | 1.0.0 | MIT in npm metadata; see trained data below | [Bundled Spanish OCR data](https://github.com/naptha/tessdata) |

Development tools such as TypeScript, Electron Forge and `@types/yauzl` retain
their upstream notices in their installed packages. Electron distributions also
carry their own Chromium and third-party license artifacts; this document does
not replace them.

## OCR trained data

The installed `eng` and `spa` 1.0.0 package manifests declare MIT and contain no
standalone license file. Their linked upstream `naptha/tessdata` repository
ships an Apache-2.0 license for its trained data. Both facts are recorded here;
the npm metadata is not treated as permission to discard the upstream data
license or relabel the weights as Warden source.

Warden retains the unmodified
[upstream trained-data license](docs/licenses/naptha-tessdata-LICENSE.txt), copied
from [commit 806cd9adc8c6e8abc11c782db1818c990576bebc](https://github.com/naptha/tessdata/blob/806cd9adc8c6e8abc11c782db1818c990576bebc/LICENSE).
English and Spanish assets are installed with the application and used through
an explicit local language directory; runtime OCR has no network download
fallback. This notice applies to those installed assets, not to arbitrary
language packs somebody might add later.

## Retained license texts

[docs/licenses](docs/licenses/README.md) contains unmodified copies of the new
document dependencies' license texts, OCR core and trained-data licenses, and the
QVAC SDK license and NOTICE. The provenance index records exact source paths or
immutable source commits and SHA-256 hashes. The Saxes copy retains the complete
upstream text, including its historical notices. This directory and this file
are included in desktop packaging.

The packaged `node_modules` retain original package license and notice files as
well. Redistributors should preserve those files, the Electron distribution's
notices, and QVAC's bundled notices when changing the package layout. Removing
an unused model from a deployment does not change the license of models still
included or downloaded.

## Model weights

Warden's own Apache-2.0 license does not grant a new license to downloaded GGUF
weights. The [QVAC SDK notice](docs/licenses/qvac-sdk-0.17.1-NOTICE.txt) identifies
its registry models and their distinct terms, including model-specific notices
and restrictions. That registry notice describes more models than Warden loads
by default; its presence is not a claim that all listed models are shipped or
active in Warden.

Administrators adding their own model should retain its original model card,
license and provenance. A successful Warden compatibility test establishes
loadability and response format; it does not establish redistribution rights,
provenance, safety or policy accuracy for those weights.
