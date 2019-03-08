const rootEntries = () => {
  const mainCSS = [...document.styleSheets[0].rules];
  const rootSelector = mainCSS.filter(e => e.selectorText === ':root');
  return rootSelector[0].style.cssText.replace(/\s?;\s?/g, '|').split('|').filter(Boolean);
};

console.log(rootEntries());
