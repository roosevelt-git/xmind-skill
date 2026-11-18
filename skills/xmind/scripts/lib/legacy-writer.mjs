// XMind 8 (legacy) writer: content.xml + styles.xml + meta.xml + manifest.xml.
//
// XMind 8 keeps styles in styles.xml and points to them with style-id (a <style> element inside <topic>
// is ignored). The sheet theme has no XMind 8 equivalent that survives import, so it is folded into each
// topic's own style (central / main / sub / floating slot by depth), under the topic's own properties.

import { generateId, escapeXml, XML_INVALID } from './util.mjs';

// Numbers written into XML attributes / text: anything that isn't a finite number becomes 0, so a
// crafted value can't close the attribute and inject elements.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function buildLegacyStyles(styles) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
    xml += '<xmap-styles xmlns="urn:xmind:xmap:xmlns:style:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format"';
    xml += ' xmlns:svg="http://www.w3.org/2000/svg" version="2.0">\n  <styles>\n';
    for (const st of styles) {
        const attrs = Object.entries(st.props)
            .filter(([k]) => /^[a-z][\w:-]*$/i.test(k))
            .map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
        xml += `    <style id="${escapeXml(st.id)}" type="${escapeXml(st.type)}">\n`;
        xml += `      <${st.type}-properties ${attrs}/>\n`;
        xml += '    </style>\n';
    }
    xml += '  </styles>\n</xmap-styles>\n';
    return xml;
}

// contentJson (the modern-format sheets) → {contentXml, stylesXml | null}.
export function buildLegacy(contentJson) {
    const ctx = { styles: [], styleKeys: new Map(), theme: null };

    // Identical styles are written once and shared; a style keeps at most 64 properties (real ones
    // have a few dozen), so a theme folded into every topic can't make styles.xml balloon.
    function legacyStyleId(type, props) {
        if (!props || Object.keys(props).length === 0) return null;
        const kept = Object.fromEntries(Object.entries(props).slice(0, 64));
        const key = `${type}\u0000${JSON.stringify(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;
        if (ctx.styleKeys.has(key)) return ctx.styleKeys.get(key);
        const id = generateId();
        ctx.styles.push({ id, type, props: kept });
        ctx.styleKeys.set(key, id);
        return id;
    }

    function themedProps(slot, own) {
        const base = ctx.theme?.[slot]?.properties || {};
        const merged = { ...base, ...(own || {}) };
        return Object.keys(merged).length > 0 ? merged : null;
    }

    function topicToXml(topic, indent = '      ', slot = 'centralTopic') {
        const attrs = [`id="${escapeXml(topic.id)}"`];
        if (topic.branch === 'folded') attrs.push('branch="folded"');
        const styleId = legacyStyleId('topic', themedProps(slot, topic.style?.properties));
        if (styleId) attrs.push(`style-id="${styleId}"`);
        if (topic.structureClass) attrs.push(`structure-class="${escapeXml(topic.structureClass)}"`);
        if (topic.href) attrs.push(`xlink:href="${escapeXml(topic.href)}"`);

        let xml = `${indent}<topic ${attrs.join(' ')}>\n`;
        xml += `${indent}  <title>${escapeXml(topic.title)}</title>\n`;

        // Position
        if (topic.position) {
            xml += `${indent}  <position svg:x="${num(topic.position.x)}" svg:y="${num(topic.position.y)}"/>\n`;
        }

        // Image (an equation's rendered image is kept too — XMind 8 has no equation object)
        if (topic.image?.src) {
            const imgAttrs = [`xhtml:src="${escapeXml(topic.image.src)}"`];
            if (topic.image.width) imgAttrs.push(`svg:width="${num(topic.image.width)}"`);
            if (topic.image.height) imgAttrs.push(`svg:height="${num(topic.image.height)}"`);
            if (topic.image.align) imgAttrs.push(`align="${escapeXml(topic.image.align)}"`);
            xml += `${indent}  <xhtml:img ${imgAttrs.join(' ')}/>\n`;
        }

        // Notes
        if (topic.notes) {
            xml += `${indent}  <notes>\n`;
            if (topic.notes.plain) {
                xml += `${indent}    <plain>${escapeXml(topic.notes.plain.content)}</plain>\n`;
            }
            if (topic.notes.realHTML) {
                xml += `${indent}    <html><![CDATA[${String(topic.notes.realHTML.content).replace(XML_INVALID, '').replace(/]]>/g, ']]]]><![CDATA[>')}]]></html>\n`;
            }
            xml += `${indent}  </notes>\n`;
        }

        // Labels
        if (topic.labels?.length > 0) {
            xml += `${indent}  <labels>\n`;
            for (const label of topic.labels) {
                xml += `${indent}    <label>${escapeXml(label)}</label>\n`;
            }
            xml += `${indent}  </labels>\n`;
        }

        // Markers
        if (topic.markers?.length > 0) {
            xml += `${indent}  <marker-refs>\n`;
            for (const m of topic.markers) {
                xml += `${indent}    <marker-ref marker-id="${escapeXml(m.markerId)}"/>\n`;
            }
            xml += `${indent}  </marker-refs>\n`;
        }

        // Boundaries
        if (topic.boundaries?.length > 0) {
            xml += `${indent}  <boundaries>\n`;
            for (const b of topic.boundaries) {
                const bStyle = legacyStyleId('boundary', b.style?.properties);
                const bAttrs = `id="${escapeXml(b.id)}" range="${escapeXml(b.range)}"${bStyle ? ` style-id="${bStyle}"` : ''}`;
                if (b.title) {
                    xml += `${indent}    <boundary ${bAttrs}>\n`;
                    xml += `${indent}      <title>${escapeXml(b.title)}</title>\n`;
                    xml += `${indent}    </boundary>\n`;
                } else {
                    xml += `${indent}    <boundary ${bAttrs}/>\n`;
                }
            }
            xml += `${indent}  </boundaries>\n`;
        }

        // Summaries
        if (topic.summaries?.length > 0) {
            xml += `${indent}  <summaries>\n`;
            for (const s of topic.summaries) {
                xml += `${indent}    <summary id="${escapeXml(s.id)}" range="${escapeXml(s.range)}" topic-id="${escapeXml(s.topicId)}"/>\n`;
            }
            xml += `${indent}  </summaries>\n`;
        }

        // Extensions (task info)
        if (topic.extensions?.length > 0) {
            xml += `${indent}  <extensions>\n`;
            for (const ext of topic.extensions) {
                xml += `${indent}    <extension provider="${escapeXml(ext.provider)}">\n`;
                xml += `${indent}      <content>\n`;
                const c = ext.content;
                if (c.status) xml += `${indent}        <status>${escapeXml(c.status)}</status>\n`;
                if (c.progress !== undefined) xml += `${indent}        <progress>${num(c.progress)}</progress>\n`;
                if (c.priority !== undefined) xml += `${indent}        <priority>${num(c.priority)}</priority>\n`;
                if (c.start !== undefined) xml += `${indent}        <start>${num(c.start)}</start>\n`;
                if (c.due !== undefined) xml += `${indent}        <due>${num(c.due)}</due>\n`;
                if (c.duration !== undefined) xml += `${indent}        <duration>${num(c.duration)}</duration>\n`;
                if (c.dependencies?.length > 0) {
                    xml += `${indent}        <dependencies>\n`;
                    for (const dep of c.dependencies) {
                        xml += `${indent}          <dependency id="${escapeXml(dep.id)}" type="${escapeXml(dep.type)}" lag="${num(dep.lag)}"/>\n`;
                    }
                    xml += `${indent}        </dependencies>\n`;
                }
                xml += `${indent}      </content>\n`;
                xml += `${indent}    </extension>\n`;
            }
            xml += `${indent}  </extensions>\n`;
        }

        // Children — XMind 8 uses <topics type="attached|detached|callout|summary">
        const hasAttached = topic.children?.attached?.length > 0;
        const hasCallout = topic.children?.callout?.length > 0;
        const hasDetached = topic.children?.detached?.length > 0;
        // Summary topics go under <children><topics type="summary"> in XMind 8
        const summaryTopics = topic.children?.summary || topic.summary || [];
        const hasSummaryTopics = summaryTopics.length > 0;

        if (hasAttached || hasCallout || hasDetached || hasSummaryTopics) {
            xml += `${indent}  <children>\n`;
            if (hasAttached) {
                xml += `${indent}    <topics type="attached">\n`;
                for (const child of topic.children.attached) {
                    xml += topicToXml(child, indent + '      ', slot === 'centralTopic' ? 'mainTopic' : 'subTopic');
                }
                xml += `${indent}    </topics>\n`;
            }
            if (hasCallout) {
                xml += `${indent}    <topics type="callout">\n`;
                for (const child of topic.children.callout) {
                    xml += `${indent}      <topic id="${escapeXml(child.id)}">\n`;
                    xml += `${indent}        <title>${escapeXml(child.title)}</title>\n`;
                    xml += `${indent}      </topic>\n`;
                }
                xml += `${indent}    </topics>\n`;
            }
            if (hasDetached) {
                xml += `${indent}    <topics type="detached">\n`;
                for (const child of topic.children.detached) {
                    xml += topicToXml(child, indent + '      ', 'floatingTopic');
                }
                xml += `${indent}    </topics>\n`;
            }
            if (hasSummaryTopics) {
                xml += `${indent}    <topics type="summary">\n`;
                for (const st of summaryTopics) {
                    xml += `${indent}      <topic id="${escapeXml(st.id)}">\n`;
                    xml += `${indent}        <title>${escapeXml(st.title)}</title>\n`;
                    xml += `${indent}      </topic>\n`;
                }
                xml += `${indent}    </topics>\n`;
            }
            xml += `${indent}  </children>\n`;
        }

        xml += `${indent}</topic>\n`;
        return xml;
    }

    function buildLegacyXml(contentJson) {
        let xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
        xml += '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"';
        xml += ' xmlns:fo="http://www.w3.org/1999/XSL/Format"';
        xml += ' xmlns:svg="http://www.w3.org/2000/svg"';
        xml += ' xmlns:xhtml="http://www.w3.org/1999/xhtml"';
        xml += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
        xml += ' version="2.0">\n';

        for (const sheet of contentJson) {
            ctx.theme = sheet.theme && Object.keys(sheet.theme).length > 0 ? sheet.theme : null;
            const mapProps = { ...(ctx.theme?.map?.properties || {}), ...(sheet.style?.properties || {}) };
            const sheetStyle = legacyStyleId('map', mapProps['svg:fill'] ? { 'svg:fill': mapProps['svg:fill'] } : null);
            xml += `  <sheet id="${escapeXml(sheet.id)}"${sheetStyle ? ` style-id="${sheetStyle}"` : ''}>\n`;
            xml += `    <title>${escapeXml(sheet.title)}</title>\n`;
            xml += topicToXml(sheet.rootTopic, '    ');

            // Relationships
            if (sheet.relationships?.length > 0) {
                xml += '    <relationships>\n';
                for (const rel of sheet.relationships) {
                    const relAttrs = [`id="${escapeXml(rel.id)}"`, `end1="${escapeXml(rel.end1Id)}"`, `end2="${escapeXml(rel.end2Id)}"`];
                    const relStyleId = legacyStyleId('relationship', themedProps('relationship', rel.style?.properties));
                    if (relStyleId) relAttrs.push(`style-id="${relStyleId}"`);
                    const hasChildren = rel.title || rel.controlPoints;
                    if (hasChildren) {
                        xml += `      <relationship ${relAttrs.join(' ')}>\n`;
                        if (rel.title) xml += `        <title>${escapeXml(rel.title)}</title>\n`;
                        if (rel.controlPoints?.length > 0) {
                            xml += '        <control-points>\n';
                            rel.controlPoints.forEach((cp, i) => {
                                const cpAttrs = [`index="${i}"`];
                                if (cp.amount !== undefined) cpAttrs.push(`amount="${num(cp.amount)}"`);
                                if (cp.angle !== undefined) cpAttrs.push(`angle="${num(cp.angle)}"`);
                                xml += `          <control-point ${cpAttrs.join(' ')}/>\n`;
                            });
                            xml += '        </control-points>\n';
                        }
                        xml += '      </relationship>\n';
                    } else {
                        xml += `      <relationship ${relAttrs.join(' ')}/>\n`;
                    }
                }
                xml += '    </relationships>\n';
            }

            xml += '  </sheet>\n';
        }
        ctx.theme = null;

        xml += '</xmap-content>\n';
        return xml;
    }

    const contentXml = buildLegacyXml(contentJson);
    return { contentXml, stylesXml: ctx.styles.length > 0 ? buildLegacyStyles(ctx.styles) : null };
}

export function buildLegacyMeta() {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
    xml += '<meta xmlns="urn:xmind:xmap:xmlns:meta:2.0" version="2.0">\n';
    xml += '  <Creator><Name>xmind-skill</Name><Version>4.0.0</Version></Creator>\n';
    xml += '</meta>\n';
    return xml;
}

export function buildLegacyManifest(fileEntries) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
    xml += '<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">\n';
    for (const entry of Object.keys(fileEntries)) {
        const mediaType = entry.endsWith('.xml') ? 'text/xml' : '';
        xml += `  <file-entry full-path="${escapeXml(entry)}"${mediaType ? ` media-type="${mediaType}"` : ''}/>\n`;
    }
    xml += '</manifest>\n';
    return xml;
}
