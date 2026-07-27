package posthog

import (
	"reflect"
	"strings"
	"testing"
)

// TestNoVendorTypesInPublicAPI asserts ADR-0002's encapsulation rule: no
// posthog-go type may appear in this package's exported API surface
// (exported struct fields, exported method signatures, exported function
// signatures).
func TestNoVendorTypesInPublicAPI(t *testing.T) {
	roots := []reflect.Type{
		reflect.TypeOf(Config{}),
		reflect.TypeOf(&Adapter{}),
		reflect.TypeOf(New),
	}
	seen := map[reflect.Type]bool{}
	for _, root := range roots {
		assertNoVendorType(t, root, root.String(), seen)
	}
}

func assertNoVendorType(t *testing.T, typ reflect.Type, path string, seen map[reflect.Type]bool) {
	t.Helper()
	if typ == nil || seen[typ] {
		return
	}
	seen[typ] = true

	if pkg := typ.PkgPath(); strings.Contains(pkg, "posthog/posthog-go") {
		t.Errorf("vendor type leaked into public API at %s: %s", path, typ)
		return
	}

	switch typ.Kind() {
	case reflect.Ptr, reflect.Slice, reflect.Array, reflect.Chan:
		assertNoVendorType(t, typ.Elem(), path+"/elem", seen)
	case reflect.Map:
		assertNoVendorType(t, typ.Key(), path+"/key", seen)
		assertNoVendorType(t, typ.Elem(), path+"/value", seen)
	case reflect.Func:
		for i := 0; i < typ.NumIn(); i++ {
			assertNoVendorType(t, typ.In(i), path+"/in", seen)
		}
		for i := 0; i < typ.NumOut(); i++ {
			assertNoVendorType(t, typ.Out(i), path+"/out", seen)
		}
	case reflect.Struct:
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if !f.IsExported() {
				continue // unexported internals may hold vendor types
			}
			assertNoVendorType(t, f.Type, path+"."+f.Name, seen)
		}
	}

	// Exported methods (reflect only surfaces exported ones).
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		assertNoVendorType(t, m.Type, path+"."+m.Name+"()", seen)
	}
}
