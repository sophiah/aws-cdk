# aws-cdk

## Environment setup
```bash
npm install aws-cdk-lib
## bootstrapping
export AWS_ACCOUNT_NUMBER={YOUR_ACCOUNT_NUMBER}
export AWS_REGION=ap-northeast-1
export AWS_PROFILE={profile}
cdk bootstrapping aws://${accountNumber}/${AWS_REGION} --profile ${AWS_PROFILE}
```

## Create an App
```bash
cdk init app --language typescript
```