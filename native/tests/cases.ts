export const cases = [
  {name: "inline", standard: String.raw`Before \(x+\frac{1}{y}\) after.`, dollar: String.raw`Before $x+\frac{1}{y}$ after.`},
  {name: "inline at start", standard: String.raw`\(x+1\) after`, dollar: String.raw`$x+1$ after`},
  {name: "display", standard: "\\[\nx+1\n\\]", dollar: "$$\nx+1\n$$"},
  {name: "one-row display", standard: "\\[x+1\\]", dollar: "$$x+1$$"},
  {name: "indented display", standard: "   \\[\n   x+1\n   \\]", dollar: "   $$\n   x+1\n   $$"},
  {name: "list", standard: "1. Item\n\n   \\[\n   x+1\n   \\]", dollar: "1. Item\n\n   $$\n   x+1\n   $$"},
  {name: "quote", standard: "> \\[\n> x+1\n> \\]", dollar: "> $$\n> x+1\n> $$"},
  {name: "callout", standard: "> [!note]\n> \\[\n> x+1\n> \\]", dollar: "> [!note]\n> $$\n> x+1\n> $$"},
  {name: "mixed", standard: String.raw`\(a\) and $b$ then \[c\] and $$d$$.`, dollar: String.raw`$a$ and $b$ then $$c$$ and $$d$$.`},
  {name: "boxed", standard: String.raw`\[\boxed{\text{甲乙丙丁}\not\Rightarrow x}\]`, dollar: String.raw`$$\boxed{\text{甲乙丙丁}\not\Rightarrow x}$$`},
  {name: "adjacent punctuation", standard: String.raw`测试\(x^2+y_1\)，继续。`, dollar: String.raw`测试$x^2+y_1$，继续。`},
  {name: "table", standard: "| A | B |\n| - | - |\n| \\(a\\) | \\(b\\) |", dollar: "| A | B |\n| - | - |\n| $a$ | $b$ |"},
  {name: "emphasis", standard: String.raw`**A \(x_1\) B** and *\(y\)*.`, dollar: String.raw`**A $x_1$ B** and *$y$*.`},
  {name: "source examples", standard: "`\\(literal\\)` then \\(x\\).\n\n```tex\n\\[literal\\]\n```", dollar: "`\\(literal\\)` then $x$.\n\n```tex\n\\[literal\\]\n```"},
  {name: "frontmatter", standard: "---\nformula: '\\(literal\\)'\n---\n\n\\(x\\)", dollar: "---\nformula: '\\(literal\\)'\n---\n\n$x$"},
  {name: "escaped opener", standard: String.raw`\\(literal\\) then \(x\)`, dollar: String.raw`\\(literal\\) then $x$`},
  {name: "body backslash", standard: String.raw`\[\begin{aligned}x&=1\\y&=2\end{aligned}\]`, dollar: String.raw`$$\begin{aligned}x&=1\\y&=2\end{aligned}$$`},
  {name: "paragraph offsets", standard: "Before \\(x\\).\n\n# Heading\n\n- [ ] Task \\(y\\)\n\nEnd.", dollar: "Before $x$.\n\n# Heading\n\n- [ ] Task $y$\n\nEnd."}
];

for (const [name, before, after] of [
  ["heading", "## Title ", " end"],
  ["checklist", "- [ ] Task ", " end"],
  ["nested quote", "> > Text ", " end"],
  ["nested list", "- Outer\n  - Inner ", " end"],
  ["footnote", "Text[^1]\n\n[^1]: Formula ", " end"],
  ["highlight", "==Before ", " after=="],
  ["strikethrough", "~~Before ", " after~~"],
  ["block id", "Before ", " after ^formula"],
  ["unicode", "😀 中文 العربية ", " 👨‍👩‍👧‍👦"],
  ["adjacent formulas", "\\(a\\)", "\\(b\\)"],
] as const) {
  const standard = before + "\\(x_1+\\frac{y}{2}\\)" + after;
  const dollar = before.replaceAll("\\(a\\)", "$a$") + "$x_1+\\frac{y}{2}$" + after.replaceAll("\\(b\\)", "$b$");
  cases.push({name, standard, dollar});
}

cases.push(
  {name: "display in table", standard: "| Formula |\n| - |\n| \\[x+1\\] |", dollar: "| Formula |\n| - |\n| $$x+1$$ |"},
  {name: "blank line in display", standard: "\\[\nx+1\n\ny+1\n\\]\n\nAfter", dollar: "$$\nx+1\n\ny+1\n$$\n\nAfter"},
  {name: "escaped dollar in body", standard: String.raw`Before \(\text{Price: \$5}\) after`, dollar: String.raw`Before $\text{Price: \$5}$ after`},
  {name: "multiple display blocks", standard: "\\[\nx\n\\]\n\n\\[\ny\n\\]", dollar: "$$\nx\n$$\n\n$$\ny\n$$"},
);
