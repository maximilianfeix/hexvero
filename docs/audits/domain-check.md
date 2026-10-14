# Domain, DNS, HTTPS and GitHub Pages (checked 2026-10-14, rechecked the same evening: unchanged)

Real checks against the live services: `dig`, `openssl s_client`, `curl` and the GitHub API
(`GET /repos/maximilianfeix/hexvero/pages`). Nothing was changed.

## Results

| Check                                       | Result                                                                                                                    | Status                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `hexvero.dev` A / AAAA                      | `88.198.219.246`, `2a01:4f8:d0a:27bd::2` (Hetzner, shared web hosting `your-server.de`); same for `www`                   | FAIL: not GitHub Pages                                            |
| Name servers                                | `ns1.your-server.de`, `ns.second-ns.com`, `ns3.second-ns.de` (Hetzner DNS)                                                | info                                                              |
| CAA                                         | none                                                                                                                      | info                                                              |
| Certificate on `https://hexvero.dev`        | `CN=your-server.de`, SAN `your-server.de, *.your-server.de` (Thawte, valid 2026-10-05 to 2027-04-21)                      | FAIL: does not cover `hexvero.dev`; browsers and `curl` refuse it |
| `http://hexvero.dev/`                       | `404 Not Found` from Apache, `X-Robots-Tag: noindex`                                                                      | FAIL                                                              |
| GitHub Pages                                | `build_type: workflow`, `cname: null`, `https_enforced: true`, last two deploys of `main` succeeded                       | custom domain not set                                             |
| `https://maximilianfeix.github.io/hexvero/` | `200`, the landing page, `social-preview.png` `200`                                                                       | PASS                                                              |
| `site/CNAME`                                | contains `hexvero.dev`, but with workflow-built Pages the custom domain comes from the repository settings, not this file | no effect                                                         |

## Where the broken address is used

- `homepage` in all four `package.json` files, already published with 0.3.0 on npm
- `websiteUrl` in `server.json` (MCP registry metadata)
- the repository's homepage field on GitHub
- canonical URL, `og:url`, `og:image`, sitemap and `llms.txt` links in `site/`

A visitor who follows any of them gets a certificate warning. This blocks a public launch.

## What fixes it (needs the owner; not done here)

1. In Hetzner DNS for `hexvero.dev`, replace the apex records with GitHub Pages:
   A `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`;
   AAAA `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`;
   `www` as CNAME `maximilianfeix.github.io.` These are the addresses `maximilianfeix.github.io`
   resolves to today.
2. Verify the domain for the GitHub account (Settings → Pages → Verified domains), so no other
   repository can claim it.
3. Set the custom domain in the repository (Settings → Pages → Custom domain: `hexvero.dev`), or
   `gh api -X PUT repos/maximilianfeix/hexvero/pages -f cname=hexvero.dev`.
4. Wait for the certificate (GitHub requests it once DNS points there), then keep "Enforce HTTPS"
   on. Check with `curl -sI https://hexvero.dev/` and
   `openssl s_client -connect hexvero.dev:443 -servername hexvero.dev`.
5. Optional: a CAA record allowing `letsencrypt.org`, which GitHub Pages uses.

Until then, `https://maximilianfeix.github.io/hexvero/` works and could serve as the homepage.
