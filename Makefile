image-run:
	docker run --rm -p 8080:8080 --env-file .env $$(whoami)/sheriff

image:
	docker build -t $$(whoami)/sheriff .

image-push:
	docker push $$(whoami)/booty

prettify:
	docker run --rm -w /usr/src/app -v $$(pwd):/usr/src/app node:alpine /bin/sh -c "yarn install --frozen-lockfile && yarn prettier --write \"src/**/*.{ts,tsx}\""