package com.projecthub.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * Строки нативной части на двух языках (TASK-140.15): у каждой переводимой строки `values/` (английский) есть русская
 * в `values-ru/` с теми же подстановками, а в английских нет кириллицы.
 */
public class StringsLocaleTest {
    private static final Pattern ARG = Pattern.compile("%\\d+\\$[sd]");
    private static final Pattern CYRILLIC = Pattern.compile("[\\u0400-\\u04FF]");

    private static List<String> args(String s) {
        List<String> out = new ArrayList<>();
        Matcher m = ARG.matcher(s);
        while (m.find()) out.add(m.group());
        return out;
    }

    @Test
    public void russianCoversEveryEnglishStringWithSameArgs() throws Exception {
        Map<String, String> en = ResTexts.parse("values");
        Map<String, String> ru = ResTexts.parse("values-ru");
        assertFalse(en.isEmpty());
        assertEquals(new TreeSet<>(en.keySet()), new TreeSet<>(ru.keySet()));
        for (String key : en.keySet()) {
            assertEquals(key, args(en.get(key)), args(ru.get(key)));
            assertFalse("кириллица в английской строке " + key, CYRILLIC.matcher(en.get(key)).find());
            assertTrue("пустая русская строка " + key, !ru.get(key).trim().isEmpty());
        }
    }
}
