FROM mcr.microsoft.com/cbl-mariner/base/core:2.0
# Dummy Dockerfile to allow Radius to generate an application model for testing the Canvas graph UI themes
EXPOSE 8080
CMD ["echo", "dummy"]