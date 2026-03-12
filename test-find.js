import fs from 'fs';
const html = fs.readFileSync('yahoo-html.txt', 'utf8');

const regex = /.{0,50}Oracle.{0,50}/g;
let match;
while ((match = regex.exec(html)) !== null) {
  console.log("MATCH:", match[0]);
}
