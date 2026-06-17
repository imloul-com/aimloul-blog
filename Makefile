DIAGRAMS_BLOG_SRC := $(shell find content/blog -name '*.d2' 2>/dev/null)
DIAGRAMS_PROJ_SRC := $(shell find content/projects -name '*.d2' 2>/dev/null)

# Optional sidecar per diagram: same path as the .d2 file with suffix `.d2.opts` (whitespace-separated extra `d2` CLI args, e.g. ELK flags). D2 0.7 does not read these from inside the .d2 source.
# Blog diagrams strip `content/blog/` (the diagram shortcode strips `blog/` from the page dir); project diagrams strip only `content/`, keeping `projects/` in the path.
DIAGRAMS_DARK  := $(patsubst content/blog/%.d2,assets/diagrams/%-dark.svg,$(DIAGRAMS_BLOG_SRC))
DIAGRAMS_LIGHT := $(patsubst content/blog/%.d2,assets/diagrams/%-light.svg,$(DIAGRAMS_BLOG_SRC))
DIAGRAMS_PROJ_DARK  := $(patsubst content/%.d2,assets/diagrams/%-dark.svg,$(DIAGRAMS_PROJ_SRC))
DIAGRAMS_PROJ_LIGHT := $(patsubst content/%.d2,assets/diagrams/%-light.svg,$(DIAGRAMS_PROJ_SRC))

.PHONY: diagrams serve build

# Optional $$(wildcard …) prereq: changing a sidecar .d2.opts forces a rebuild without touching the .d2 file.
.SECONDEXPANSION:

diagrams: $(DIAGRAMS_DARK) $(DIAGRAMS_LIGHT) $(DIAGRAMS_PROJ_DARK) $(DIAGRAMS_PROJ_LIGHT)

assets/diagrams/%-dark.svg: content/blog/%.d2 $$(wildcard content/blog/$$*.d2.opts)
	@mkdir -p $(dir $@)
	@d2extra=$$([ -f '$<.opts' ] && tr '\n' ' ' < '$<.opts'); \
	d2 --theme 200 $$d2extra '$<' '$@'

assets/diagrams/%-light.svg: content/blog/%.d2 $$(wildcard content/blog/$$*.d2.opts)
	@mkdir -p $(dir $@)
	@d2extra=$$([ -f '$<.opts' ] && tr '\n' ' ' < '$<.opts'); \
	d2 --theme 0 $$d2extra '$<' '$@'

# More specific than the blog rules above (longer literal prefix), so make picks these for project diagrams.
assets/diagrams/projects/%-dark.svg: content/projects/%.d2 $$(wildcard content/projects/$$*.d2.opts)
	@mkdir -p $(dir $@)
	@d2extra=$$([ -f '$<.opts' ] && tr '\n' ' ' < '$<.opts'); \
	d2 --theme 200 $$d2extra '$<' '$@'

assets/diagrams/projects/%-light.svg: content/projects/%.d2 $$(wildcard content/projects/$$*.d2.opts)
	@mkdir -p $(dir $@)
	@d2extra=$$([ -f '$<.opts' ] && tr '\n' ' ' < '$<.opts'); \
	d2 --theme 0 $$d2extra '$<' '$@'

serve: diagrams
	hugo server --disableFastRender

build: diagrams
	hugo --minify
