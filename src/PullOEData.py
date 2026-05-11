import gdown
import os

folder_id = "1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH"
file_id = "1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm"


output_path = "../data/raw/"

# function called within the gdown library to get all the files in the OE public folder


if not os.path.exists("../data/raw/static_file.csv"):
    gdown.download_folder(id = folder_id, output = output_path, quiet = False)

gdown.download(id= file_id, output="../data/raw/daily_file.csv")



