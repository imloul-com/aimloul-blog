DIAGRAMS_SRC := $(wildcard diagrams/*.d2)
DIAGRAMS_DARK  := $(patsubst diagrams/%.d2,assets/diagrams/%-dark.svg,$(DIAGRAMS_SRC))
DIAGRAMS_LIGHT := $(patsubst diagrams/%.d2,assets/diagrams/%-light.svg,$(DIAGRAMS_SRC))

.PHONY: diagrams serve build

diagrams: $(DIAGRAMS_DARK) $(DIAGRAMS_LIGHT)

assets/diagrams/%-dark.svg: diagrams/%.d2
	d2 --theme 200 $< $@

assets/diagrams/%-light.svg: diagrams/%.d2
	d2 --theme 0 $< $@

serve: diagrams
	hugo server

build: diagrams
	hugo build
