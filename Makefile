DIAGRAMS_SRC   := $(shell find content -name '*.d2')
DIAGRAMS_DARK  := $(patsubst content/posts/%.d2,assets/diagrams/%-dark.svg,$(DIAGRAMS_SRC))
DIAGRAMS_LIGHT := $(patsubst content/posts/%.d2,assets/diagrams/%-light.svg,$(DIAGRAMS_SRC))

.PHONY: diagrams serve build

diagrams: $(DIAGRAMS_DARK) $(DIAGRAMS_LIGHT)

assets/diagrams/%-dark.svg: content/posts/%.d2
	@mkdir -p $(dir $@)
	d2 --theme 200 $< $@

assets/diagrams/%-light.svg: content/posts/%.d2
	@mkdir -p $(dir $@)
	d2 --theme 0 $< $@

serve: diagrams
	hugo server --disableFastRender

build: diagrams
	hugo --minify
