import type { PresentationSlide, TextElementKey } from "./presentations";

export const addedContentStep = 6;

export function textRevealStep(layout: PresentationSlide["layout"], key?: TextElementKey) {
  if (!key) return addedContentStep;
  if (layout === "cover") return /^(keyword|metric)/.test(key) ? 1 : 0;
  if (key === "title") return 0;
  if (key.startsWith("left")) return 1;
  if (key.startsWith("right")) return 2;
  return Number(/^(?:point|metric|step)([1-5])/.exec(key)?.[1] ?? 1);
}

export function addSlideRevealAnimations(xml: string, groups: readonly (readonly string[])[]) {
  const shapeIds = new Map(Array.from(xml.matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g),
    ([, id, name]) => [name, id]));
  let nextNodeId = 3;
  const startNow = '<p:stCondLst><p:cond delay="0"/></p:stCondLst>';
  const clicks = groups.map((names) => {
    const clickId = nextNodeId++;
    const groupId = nextNodeId++;
    const effects = names.map((name, index) => {
      const shapeId = shapeIds.get(name);
      if (!shapeId) throw new Error(`Missing PowerPoint animation target: ${name}`);
      const effectId = nextNodeId++;
      const behaviorId = nextNodeId++;
      const start = index === 0 ? "clickEffect" : "withEffect";
      return `<p:par><p:cTn id="${effectId}" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="${start}">
        ${startNow}<p:childTnLst><p:set><p:cBhvr>
          <p:cTn id="${behaviorId}" dur="1" fill="hold">${startNow}</p:cTn>
          <p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>
          <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>
        </p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst>
      </p:cTn></p:par>`;
    }).join("");
    return `<p:par><p:cTn id="${clickId}" fill="hold">
      <p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>
        <p:par><p:cTn id="${groupId}" fill="hold">${startNow}<p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par>
      </p:childTnLst>
    </p:cTn></p:par>`;
  }).join("");
  const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">
    <p:childTnLst><p:seq concurrent="1" nextAc="seek">
      <p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks}</p:childTnLst></p:cTn>
      <p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>
      <p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>
    </p:seq></p:childTnLst>
  </p:cTn></p:par></p:tnLst></p:timing>`;
  return xml.replace("</p:sld>", timing + "</p:sld>");
}
