# Image transformation and size-selection contract

Both SDKs implement SPEC.md image downloads with sharp 0.34.5 (TypeScript) and Pillow 12.3.0 (Python; supported dependency range >=11.3,<13). These are package dependencies, not optional runtime promises. Python >=3.10 remains the declared minimum.

## Processing order and output

The built-in downloader fetches with the existing DNS/redirect/stream policy, validates a static JPEG/PNG/WebP, normalizes EXIF orientation when transforming, crops, resizes, composites watermarks, and encodes. Crop coordinates are measured on the oriented image and must fit entirely inside it. Resize preserves aspect ratio, fits inside maxWidth/maxHeight, and never enlarges. Untransformed images are fully decoded for validation, then retain their original bytes.

`format` encodes JPEG, PNG, or WebP. `quality` is 0–100 (rounded; zero maps to the encoder minimum 1). JPEG/WebP use encoder quality. PNG quality requests palette quantization/fidelity; omit quality for ordinary lossless PNG encoding. JPEG flattens alpha onto white. Returned format/dimensions/size describe the encoded bytes, not the source. Metadata is returned only when requested. Auto-generated filenames use the requested format extension; an explicit filename is preserved.

Watermarks accept text, an image, or both (image first, then text). Positions are top-left/top-right/bottom-left/bottom-right/center; default bottom-right. Opacity defaults to 0.5 and is multiplied by existing alpha; zero is transparent. Image marks fit inside the output without enlargement. Text uses the runtime's default sans font at 24px and fits into the image; text rendering/font coverage is not promised to be pixel-identical across platforms or SDKs. TypeScript escapes Pango markup so text is literal. Python uses Pillow's bundled default font. Input text is capped at 4096 characters.

Watermark images can be local filesystem paths (trusted application input) or HTTP(S) URLs. Remote marks use the same private-host, DNS, redirect, byte-limit, and deadline enforcement as source downloads. Other URI schemes are rejected. Local mark reads are bounded by maxPayloadBytes. Images are limited to 40 million decoded pixels, static frames, and supported formats; corrupt/truncated payloads fail before publication. Encoded output is also capped by maxPayloadBytes. CPU processing is not part of the network's 30-second deadline; callers should bound batch concurrency for large images.

## Provider size selection

`images.download` accepts the existing URL string or an `ImageResult`. For results, `size` selects the exact corresponding `downloads` URL. A requested provider size missing from the result fails explicitly. In particular, Pixabay original is only available when its API supplies imageURL; largeImageURL is not mislabeled as original.

Each ImageBrowser remembers up to 1000 URL aliases from its searches, including source-page URLs and download URLs. Existing string callers can search then download a returned URL with `size`; the remembered provider URL is selected. The selected URL still passes the protected downloader's checks. Explicit ImageResult input avoids dependence on this bounded per-instance lookup.

A direct URL with no known search result uses size as a local bounding box: small=640×640, medium=1280×1280, large=2048×2048; original preserves dimensions. Explicit maxWidth/maxHeight override the corresponding preset dimension. Selecting a provider URL suppresses this fallback bounding box; explicit crop/resize/format/watermark options still apply.

Custom TypeScript provider.download remains trusted and receives the selected URL plus the original options (including size), preserving provider-specific transforms. Python built-in provider.download methods share the transformation pipeline as well as secure fetch/write helpers. Public facade event/log contexts retain string URLs for the new ImageResult input.

## Checks

Actual encoded/decoded tests cover all output formats, crop/resize pixel selection, quality differences, text/image placement and alpha, zero opacity, direct size bounds/no enlargement, missing provider sizes, corrupt/out-of-bounds inputs, private watermark URL blocking, custom provider preservation, provider downloads, and exact size URL selection through the public facades with localhost HTTP.

TypeScript focused image/provider tests: 25 passed. Python 3.10 image/security/transform tests: 23 passed; its full suite also passes 85 tests. Final full release gate: TypeScript build/typecheck plus 106 tests, Python 3.12 compile plus 85 tests, duplication 4.856964619909099% (545 lines / 46 clones / 66 source files). Logs: `/tmp/sf-browse-transform-gate.log` and `/tmp/sf-browse-transform-py310.log`. `git diff --check` passes.

Native public-provider credentials, all OS/font combinations, and hostile local filesystem parents were not exercised. The destination ownership and custom-provider trust boundaries in image-download-security.md still apply.

Implementation references: [sharp input limits and text](https://sharp.pixelplumbing.com/api-constructor/), [sharp resize](https://sharp.pixelplumbing.com/api-resize/), [Pillow image operations](https://pillow.readthedocs.io/en/stable/reference/Image.html), [Pillow text drawing](https://pillow.readthedocs.io/en/stable/reference/ImageDraw.html).
