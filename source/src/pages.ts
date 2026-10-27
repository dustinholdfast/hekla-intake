/**
 * The asset server's default html_handling (auto-trailing-slash) serves `/credit`
 * from `credit.html`, and answers a request for `/credit.html` with 307 Location: /credit.
 * Asking ASSETS for the `.html` path and returning that redirect makes the browser
 * request the same clean URL again, which is a loop. `/purchases.html` redirects to
 * `/purchases`, so rewriting `/purchases/new` to the `.html` file sends the browser
 * to `/purchases`, and that path then redirects to itself.
 * Fetch the clean URL instead. `/purchases/new` is not its own file; it is the purchase page.
 */
export function pageAssetRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname !== "/purchases/new") return request;
  url.pathname = "/purchases";
  return new Request(url, request);
}
