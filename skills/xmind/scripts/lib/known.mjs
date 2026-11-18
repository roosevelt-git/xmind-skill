// The one list of values XMind (27.x) knows — checked against its bundled renderer. Used both by
// create_xmind.mjs (to reject bad input) and by validate (to check existing files).

export const STRUCTURES = ['map', 'map.clockwise', 'map.anticlockwise', 'map.unbalanced', 'map.unbalanced.symmetric',
    'map.floating', 'map.floating.clockwise', 'map.floating.anticlockwise', 'logic.right', 'logic.left',
    'logic-chart.right', 'logic-chart.left', 'org-chart.down', 'org-chart.up', 'tree.right', 'tree.left',
    'tree.right.btt', 'tree.left.btt', 'tree.branch-aligned.right', 'tree.branch-aligned.left',
    'tree.branch-aligned.right.btt', 'tree.branch-aligned.left.btt', 'fishbone.leftHeaded', 'fishbone.rightHeaded',
    'fishbone.leftHeaded.top', 'fishbone.leftHeaded.bottom', 'fishbone.rightHeaded.top', 'fishbone.rightHeaded.bottom',
    'brace.right', 'brace.left', 'treetable', 'treetable.toptitle', 'treetable.righttitle', 'treetable.bottomtitle',
    'spreadsheet', 'spreadsheet.column', 'grid', 'timeline.horizontal', 'timeline.horizontal.up',
    'timeline.horizontal.down', 'timeline.horizontal.rtl', 'timeline.vertical', 'timeline.vertical.btt',
    'timeline.sided.horizontal', 'timeline.sided.horizontal.rtl', 'timeline.through.vertical',
    'timeline.through.vertical.btt', 'timeline.through.symmetric.vertical', 'timeline.through.symmetric.vertical.btt'];

export const TOPIC_SHAPES = ['bookmark', 'callout', 'card', 'circle', 'cloud', 'curlyBracket', 'cutdiamond', 'data',
    'database', 'decision', 'delay', 'diamond', 'document', 'doubleBookQuote', 'doubleQuote', 'doubleroundedangle',
    'doubleunderline', 'ellipse', 'ellipserect', 'ellipticrectangle', 'fatLeftArrow', 'fatRightArrow', 'flag',
    'handDrawnEllipse', 'handDrawnRect', 'handDrawnRoundedRect', 'handDrawnUnderline', 'heart', 'hexagon', 'label',
    'leaf', 'manualInput', 'manualOperation', 'matrixMain', 'multiDocument', 'newcloud', 'noBorder',
    'offPageReference', 'onPageReference', 'parallelogram', 'predefinedProcess', 'rect', 'roundBracket',
    'roundedhexagon', 'roundedRect', 'shadowCard', 'shield', 'simpleCloud', 'singleBookQuote', 'singlebreakangle',
    'singlebreakanglewithline', 'squareBracket', 'squareQuote', 'stack', 'star', 'trapezoid', 'treetable',
    'underline', 'waterdrop'];

export const ARROWS = ['none', 'triangle', 'normal', 'spearhead', 'antiTriangle', 'dot', 'ring', 'square',
    'squarering', 'diamond', 'herringbone', 'hook', 'eye', 'doublearrow', 'attached'];
// Earlier versions of this skill documented "antTriangle", which XMind ignores (no arrow head).
export const ARROW_ALIASES = { antTriangle: 'antiTriangle' };

// Friendly branch-line names → XMind classes (brace / timeline exist but are layout-internal).
export const BRANCH_LINES = {
    curve: 'org.xmind.branchConnection.curve',
    straight: 'org.xmind.branchConnection.straight',
    elbow: 'org.xmind.branchConnection.elbow',
    roundedElbow: 'org.xmind.branchConnection.roundedElbow',
    fold: 'org.xmind.branchConnection.fold',
    roundedFold: 'org.xmind.branchConnection.roundedfold',
    bight: 'org.xmind.branchConnection.bight',
    arrowedCurve: 'org.xmind.branchConnection.arrowedCurve',
    none: 'org.xmind.branchConnection.none',
};
const BRANCH_CLASSES = [...Object.values(BRANCH_LINES), 'org.xmind.branchConnection.brace',
    'org.xmind.branchConnection.timeline'];

export const RELATIONSHIP_SHAPES = ['angled', 'curved', 'flexible', 'quad', 'straight', 'threePoint', 'zigzag'];
export const BOUNDARY_SHAPES = ['roundedRect', 'rect', 'scallops', 'waves', 'tension', 'polygon', 'roundedPolygon',
    'cross', 'focus', 'newboundary'];
export const SUMMARY_SHAPES = ['round', 'square', 'curly', 'bracket', 'angle', 'sharp', 'straight', 'fold'];

export const LINE_PATTERNS = ['solid', 'dash', 'dot', 'dash-dot', 'dash-dot-dot', 'handdrawn-solid', 'handdrawn-dash',
    'handdrawn-dot', 'handdrawn-dash-dot', 'handdrawn-dash-dot-dot'];
export const STROKE_PATTERNS = [...LINE_PATTERNS, 'none'];
export const FILL_PATTERNS = { solid: 'solid', none: 'none', handDrawn: 'solid-hand-drawn', 'solid-hand-drawn': 'solid-hand-drawn' };
export const TEXT_TRANSFORMS = ['manual', 'uppercase', 'lowercase', 'capitalize'];
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const IMAGE_ALIGNS = ['top', 'bottom', 'left', 'right'];
// numberChildren values → XMind's numbering patterns (the "1." / "A." / "a." / "I." menu).
export const NUMBERING = { arabic: 'numeral-arabic', upper: 'alphabet-uppercase', lower: 'alphabet-lowercase', roman: 'numeral-roman' };
export const TASK_STATUSES = ['todo', 'done'];

// Built-in marker ids: task-…, priority-…, flag-…, star-…, people-…, smiley-…, arrow-…, month-…, week-…, …
export const MARKER_PREFIX = /^(task|priority|flag|star|half-star|people|smiley|arrow|month|week|tag|symbol|c_simbol|c_symbol|academic|social|celebration|other)[-_]/;

// Full XMind class names, for validating files.
export const KNOWN = {
    structure: new Set(STRUCTURES.map(x => `org.xmind.ui.${x}`)),
    topicShape: new Set(TOPIC_SHAPES.map(x => `org.xmind.topicShape.${x}`)),
    arrow: new Set(ARROWS.map(x => `org.xmind.arrowShape.${x}`)),
    branch: new Set(BRANCH_CLASSES),
    relationship: new Set(RELATIONSHIP_SHAPES.map(x => `org.xmind.relationshipShape.${x}`)),
    boundary: new Set(BOUNDARY_SHAPES.map(x => `org.xmind.boundaryShape.${x}`)),
    summary: new Set(SUMMARY_SHAPES.map(x => `org.xmind.summaryShape.${x}`)),
    markerPrefix: MARKER_PREFIX,
};

// Topic fields create_xmind.mjs acts on. The XMind 8 reader passes unknown <topic> attributes
// through, but never under one of these names: a hostile file must not be able to turn a
// read → edit → write round trip into "embed this file from your disk" (attachment, image, audio…).
export const TOPIC_INPUT_FIELDS = new Set(['attachment', 'audio', 'bold', 'borderColor', 'borderPattern',
    'borderWidth', 'boundaries', 'branchLine', 'callouts', 'children', 'cjkFontFamily', 'color', 'customWidth',
    'dependencies', 'detachedTopics', 'dueDate', 'duration', 'durationDays', 'equation', 'extensions', 'fill',
    'fillOpacity', 'fillPattern', 'folded', 'fontFamily', 'fontSize', 'handDrawn', 'highlight', 'href', 'id',
    'illustration', 'image', 'italic', 'labels', 'lineColor', 'linePattern', 'lineWidth', 'linkPreview',
    'linkToRef', 'linkToTopic', 'markers', 'matrix', 'matrixColumns', 'notes', 'numberChildren', 'numbering',
    'path', 'position', 'priority', 'progress', 'ref', 'shape', 'sticker', 'startDate', 'strike',
    'structureClass', 'style', 'summaries', 'summaryTopics', 'taskStatus', 'textAlign', 'textColor',
    'textTransform', 'thumbnail', 'title', 'titleRuns', 'underline', 'video', 'width', 'sheetTitle',
    '__proto__', 'constructor', 'prototype']);

// Image keys the readers return (and create accepts back). Anything else in a file's image object —
// "path" above all — is dropped.
export const IMAGE_KEYS = ['src', 'width', 'height', 'align', 'opacity', 'borderColor', 'borderWidth',
    'shadowVisible', 'lockRatio'];
