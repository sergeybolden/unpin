# Security

Unpin opens files made by strangers and promises that nothing leaves your browser. A report that breaks either promise is welcome.

## Reporting a problem

Report it privately: open **[Report a vulnerability](https://github.com/sergeybolden/unpin/security/advisories/new)** on the repository's Security tab. Please don't open a public issue for it.

Say which browser and version you used and what you did. If a file shows the problem, attach it: the report is private, so the file stays between us.

## What counts

- The page sends a photo, its data or anything about it to another server.
- A downloaded file still holds something Unpin said it removed: location, time, device, serial numbers, names, the hidden preview or Content Credentials.
- A covered code can still be scanned in the downloaded file.
- A crafted file runs script on the page, changes what Unpin reports about another photo, or gets around the page's Content Security Policy.
- A crafted file freezes the tab or makes it run out of memory.

## Known limits

These are described in the [README](README.md) and are not vulnerabilities:

- Data deliberately added inside the compressed picture data of a JPEG or WebP may stay when the file is cleaned without being saved again.
- An invisible watermark in the pixels, such as Google's SynthID, stays.
- Faces are blurred but not checked again after that.
- Unpin can't find every clue in the picture itself: a street sign or a view from a window is for you to cover.

## Versions

There are no numbered releases. The supported version is the one at https://unpin.sergeybolden.com/, built from the `main` branch.
