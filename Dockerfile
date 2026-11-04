# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
ADD --checksum=sha256:2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.14.0/gson-2.14.0.jar gson.jar
COPY ShuttleServer.java .
RUN javac -cp gson.jar -d classes ShuttleServer.java

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/classes classes
COPY --from=build /app/gson.jar gson.jar
COPY public public
ENV PORT=80
EXPOSE 80
CMD ["java", "-cp", "classes:gson.jar", "ShuttleServer"]
