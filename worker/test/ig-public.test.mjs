import assert from "node:assert/strict";
import test from "node:test";
import { parseIgProfile } from "../src/ig-public.js";

const spec = { handle: "orbitfox", url: "https://www.instagram.com/orbitfox/" };

test("a public profile JSON keeps the caption and both slides", () => {
  const body = JSON.stringify({
    data: {
      user: {
        username: "orbitfox",
        full_name: "Orbit Fox",
        is_private: false,
        edge_owner_to_timeline_media: {
          edges: [{
            node: {
              shortcode: "Abcd1234",
              taken_at_timestamp: 1763600000,
              edge_media_to_caption: { edges: [{ node: { text: "Building something new" } }] }
            }
          }]
        }
      }
    }
  });
  const parsed = parseIgProfile(body, spec);
  assert.equal(parsed.profile.handle, "orbitfox");
  assert.equal(parsed.posts.length, 1);
  assert.equal(parsed.posts[0].id, "Abcd1234");
  assert.equal(parsed.posts[0].text, "Building something new");
  assert.equal(parsed.posts[0].url, "https://www.instagram.com/p/Abcd1234/");
});

test("a login wall is not a timeline", () => {
  assert.equal(parseIgProfile('{"message":"login_required","require_login":true}', spec), null);
  assert.equal(parseIgProfile("<html>accounts/login</html>", spec), null);
  assert.equal(parseIgProfile("<html>httpErrorPage</html>", spec), null);
});

test("a profile embed context lists the shortcode", () => {
  const packed = JSON.stringify({
    context: { graphql_media: [{ shortcode_media: { shortcode: "Clip5678", product_type: "clips", edge_media_to_caption: { edges: [{ node: { text: "A short clip" } }] } } }] }
  }).replace(/"/g, '\\"');
  const html = '<html><script>"contextJSON":"' + packed + '"}]],["NavigationMetrics"</script></html>';
  const parsed = parseIgProfile(html, spec);
  assert.ok(parsed);
  assert.equal(parsed.posts[0].id, "Clip5678");
  assert.equal(parsed.posts[0].url, "https://www.instagram.com/reel/Clip5678/");
});
