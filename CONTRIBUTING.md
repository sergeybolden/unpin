# Contributing

Unpin is a small project made by one person. Bug reports and small fixes help the most.

## Reporting a bug

Open an [issue](https://github.com/sergeybolden/unpin/issues) with your browser and its version, what you did, and what you expected to happen.

Issues are public. Attach a photo only if you are happy for anyone to see it and everything written in its file, the location included.

A security problem goes through [SECURITY.md](SECURITY.md), not a public issue.

## Changing the code

It's a static site with no build step: change a file and reload the page.

```bash
npm install
npm test
npm run preview
```

`npm run preview` serves the site at http://127.0.0.1:8000.

- The tests run before every deploy and must pass. A change to how files are read or cleaned needs a test in `tests/`.
- The page connects to no other server, and its Content Security Policy enforces that. Keep it that way: no analytics, no third-party fonts or scripts.
- The libraries in `vendor/` are copied there by `npm run vendor`. Don't edit them by hand: `scripts/vendor.mjs` also applies a security patch to `vendor/exifr.mjs` and stops if the library has changed.
- For anything larger than a fix, open an issue first, so we can agree on it before you spend the time.

## License

Your contribution is released under the [MIT license](LICENSE), like the rest of the project.
