# Val Thing

A small local bridge experiment for personal development workflows.

The project contains:

- a Chromium extension;
- a local Node.js companion; and
- shared protocol code.

## Development

Requires Node.js 24 or newer.

```shell
npm ci
npm run build
npm start
```

Run the project checks with:

```shell
npm run check
```

Packaged builds are published through the repository's Releases page.

```shell
npx --yes https://github.com/dashdogy/Val-Thing/releases/latest/download/install.tgz
```

The companion listens on all IPv4 interfaces by default. Keep its API key
private and use it only on a trusted network.

Use only with services and accounts you are authorized to access, and follow the applicable policies and terms.
