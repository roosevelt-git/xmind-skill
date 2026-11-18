# Logic and flow diagrams

Free-positioned diagrams (flowcharts, algorithms) built from detached topics and straight relationships.

## Logic / Flow diagrams

For flowcharts, logic diagrams, or algorithmic diagrams, use **free positioning** with **detached topics** and **straight relationships**:

```json
{
  "path": "/tmp/flowchart.xmind",
  "sheets": [{
    "title": "Algorithm",
    "freePositioning": true,
    "rootTopic": {
      "title": "START",
      "shape": "org.xmind.topicShape.ellipserect",
      "structureClass": "org.xmind.ui.map.clockwise"
    },
    "detachedTopics": [
      {"title": "IS X > 0?", "position": {"x": 0, "y": 130}, "shape": "org.xmind.topicShape.diamond"},
      {"title": "PRINT YES", "position": {"x": 200, "y": 130}},
      {"title": "PRINT NO", "position": {"x": -200, "y": 130}},
      {"title": "END", "position": {"x": 0, "y": 260}, "shape": "org.xmind.topicShape.ellipserect"}
    ],
    "relationships": [
      {"sourceTitle": "START", "targetTitle": "IS X > 0?", "shape": "org.xmind.relationshipShape.straight"},
      {"sourceTitle": "IS X > 0?", "targetTitle": "PRINT YES", "title": "YES", "shape": "org.xmind.relationshipShape.straight"},
      {"sourceTitle": "IS X > 0?", "targetTitle": "PRINT NO", "title": "NO", "shape": "org.xmind.relationshipShape.straight"},
      {"sourceTitle": "PRINT YES", "targetTitle": "END", "shape": "org.xmind.relationshipShape.straight"},
      {"sourceTitle": "PRINT NO", "targetTitle": "END", "shape": "org.xmind.relationshipShape.straight"}
    ]
  }]
}
```

**Conventions:** Use **ellipse** for start/end, **diamond** for conditions, **rectangle** (default) for actions, **parallelogram** for I/O. Use `"org.xmind.relationshipShape.straight"` for all connectors, and add `"pattern": "solid", "arrowEnd": "triangle"` — XMind's default theme draws relationships dashed, which reads as "optional" in a flowchart. Position topics on a grid (y increments of ~130px, x offsets of ~200px for branches).

When the user mentions "flowchart", "algorithm", "logic diagram", "流程图", "逻辑图", "算法图", "程序流程", use this pattern.
