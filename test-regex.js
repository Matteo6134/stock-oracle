import fs from 'fs';

const html = fs.readFileSync('yahoo-html.txt', 'utf8');

// The original script matched 78 times for /data-symbol="[^"]+"/g
const matches = html.match(/data-symbol="[^"]+"/g);
if (matches) {
  console.log(matches.slice(0, 10));
} else {
  console.log("No data-symbol matches.");
}

// Let's also check for class names or json data
const jsonMatches = html.match(/"symbol":"([A-Z]+)"/g);
if (jsonMatches) {
  console.log(jsonMatches.slice(0, 10));
}
