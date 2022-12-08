image-run:
	docker run --rm -p 8080:8080 --env-file .env $$(whoami)/sheriff

image:
	docker build -t $$(whoami)/sheriff .

image-push:
	docker push $$(whoami)/booty