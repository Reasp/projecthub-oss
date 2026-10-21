package com.projecthub.mobile;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * `Texts` для JVM-теста (TASK-140.15): строки из настоящего `res/<values>/strings.xml`, id — из `R.string` по имени.
 * Так тест проверяет и выбор ресурса форматтером, и сами тексты локали.
 */
final class ResTexts implements Texts {
    final Map<String, String> byName;
    private final Map<Integer, String> byId = new LinkedHashMap<>();

    private ResTexts(Map<String, String> byName) throws Exception {
        this.byName = byName;
        for (Map.Entry<String, String> e : byName.entrySet()) {
            byId.put(R.string.class.getField(e.getKey()).getInt(null), e.getValue());
        }
    }

    /** Строки каталога `values` (английский) или `values-ru`; фолбэк на `values`, как у Android. */
    static ResTexts load(String valuesDir) throws Exception {
        Map<String, String> all = parse("values");
        if (!"values".equals(valuesDir)) all.putAll(parse(valuesDir));
        return new ResTexts(all);
    }

    /** Только строки самого каталога, без фолбэка. Рабочий каталог JVM-теста Gradle — модуль `app`. */
    static Map<String, String> parse(String valuesDir) throws Exception {
        File file = new File("src/main/res/" + valuesDir + "/strings.xml");
        NodeList nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).getElementsByTagName("string");
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element el = (Element) nodes.item(i);
            if ("false".equals(el.getAttribute("translatable"))) continue;
            out.put(el.getAttribute("name"), el.getTextContent().replace("\\'", "'").replace("\\\"", "\""));
        }
        return out;
    }

    @Override
    public String get(int resId) {
        String s = byId.get(resId);
        if (s == null) throw new IllegalArgumentException("нет строки " + resId);
        return s;
    }
}
