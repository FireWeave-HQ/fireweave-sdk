package ai.fireweave.sdk;

import ai.fireweave.sdk.application.FireweaveClient;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Architecture test: no vendor types (PostHog, OpenFeature, Jackson, ...) may appear anywhere in
 * the public API of the core SDK — the core is vendor-neutral by design (ADR-0002); vendor
 * bridging lives in fireweave-adapter-posthog / fireweave-openfeature.
 */
class PublicApiVendorScanTest {

    private static final List<String> FORBIDDEN_PREFIXES = List.of(
            "com.posthog", "dev.openfeature", "com.fasterxml.jackson", "org.springframework");

    @Test
    void publicApiContainsNoVendorTypes() throws Exception {
        List<String> violations = new ArrayList<>();
        for (Class<?> cls : loadModuleClasses()) {
            if (!Modifier.isPublic(cls.getModifiers())) {
                continue;
            }
            for (Constructor<?> c : cls.getConstructors()) {
                checkTypes(violations, cls, "ctor", c.getParameterTypes());
            }
            for (Method m : cls.getMethods()) {
                if (m.getDeclaringClass() == Object.class) {
                    continue;
                }
                checkTypes(violations, cls, m.getName(), m.getParameterTypes());
                checkType(violations, cls, m.getName() + " return", m.getReturnType());
            }
            for (Field f : cls.getFields()) {
                checkType(violations, cls, f.getName(), f.getType());
            }
            Class<?> superclass = cls.getSuperclass();
            if (superclass != null) {
                checkType(violations, cls, "superclass", superclass);
            }
            for (Class<?> iface : cls.getInterfaces()) {
                checkType(violations, cls, "interface", iface);
            }
        }
        assertTrue(violations.isEmpty(), "vendor types leaked into public API:\n"
                + String.join("\n", violations));
    }

    private static void checkTypes(List<String> violations, Class<?> owner, String member,
                                   Class<?>[] types) {
        for (Class<?> t : types) {
            checkType(violations, owner, member, t);
        }
    }

    private static void checkType(List<String> violations, Class<?> owner, String member, Class<?> type) {
        Class<?> component = type;
        while (component.isArray()) {
            component = component.getComponentType();
        }
        String name = component.getName();
        for (String prefix : FORBIDDEN_PREFIXES) {
            if (name.startsWith(prefix)) {
                violations.add(owner.getName() + "#" + member + " exposes " + name);
            }
        }
    }

    private static List<Class<?>> loadModuleClasses() throws IOException, URISyntaxException {
        Path classesDir = Paths.get(
                FireweaveClient.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        try (Stream<Path> files = Files.walk(classesDir)) {
            return files.filter(p -> p.toString().endsWith(".class"))
                    .map(p -> classesDir.relativize(p).toString()
                            .replace('/', '.').replaceAll("\\.class$", ""))
                    .map(name -> {
                        try {
                            return Class.forName(name);
                        } catch (Throwable e) {
                            return null;
                        }
                    })
                    .filter(java.util.Objects::nonNull)
                    .collect(Collectors.toList());
        }
    }
}
